import { ADTClient, AtcWorkList, UriParts } from "abap-adt-api"
import { string } from "fp-ts"
import { Task } from "fp-ts/lib/Task"
import { commands, EventEmitter, Position, Selection, ThemeColor, ThemeIcon, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri, window, workspace } from "vscode"
import { AdtObjectFinder } from "../../adt/operations/AdtObjectFinder"
import { AbapFsCommands, command } from "../../commands"
import { showErrorMessage } from "../../lib"
import { getVariant, runInspector } from "./codeinspector"
import { triggerUpdateDecorations } from "./decorations"
type AtcWLobject = AtcWorkList["objects"][0]
type AtcWLFinding = AtcWLobject["findings"][0]
// tslint:disable:max-classes-per-file

export interface FindingMarker {
    finding: AtcWLFinding,
    uri: string,
    start: Position
}

export const hasExemption = (f: AtcWLFinding) => !!f.exemptionApproval

class AtcRoot extends TreeItem {
    systems = new Map<string, AtcSystem>()
    constructor(label: string, private parent: AtcProvider) {
        super(label, TreeItemCollapsibleState.Expanded)
    }
    get children() {
        return [...this.systems.values()]
    }
    async child(key: string, creator: Task<string>) {
        const cached = this.systems.get(key)
        if (cached) return cached
        const variant = await creator()
        const system = new AtcSystem(key, variant, this)
        this.systems.set(key, system)
        this.parent.emitter.fire(undefined)
        return system
    }
    static isA(x: any): x is AtcRoot {
        return x instanceof AtcRoot
    }
}

class AtcSystem extends TreeItem {
    children: AtcObject[] = []
    async setWorklist(worklist: AtcWorkList) {
        const finder = new AdtObjectFinder(this.connectionId)
        this.children = []
        for (const object of worklist.objects) this.children.push(await AtcObject.create(object, this, finder))
    }
    constructor(public readonly connectionId: string, public readonly variant: string, public readonly parent: AtcRoot) {
        super(connectionId, TreeItemCollapsibleState.Expanded)
    }
}

class AtcObject extends TreeItem {
    children: AtcFind[] = []
    static async create(object: AtcWLobject, parent: AtcSystem, finder: AdtObjectFinder) {
        const obj = new AtcObject(object, parent, finder)
        for (const f of object.findings) {
            const { uri, start } = await finder.vscodeRange(f.location)
            const finding = new AtcFind(f, obj, uri, start)
            obj.children.push(finding)
        }
        return obj
    }
    constructor(public readonly object: AtcWLobject, public readonly parent: AtcSystem, finder: AdtObjectFinder) {
        super(`${object.type} ${object.name}`, TreeItemCollapsibleState.Expanded)
    }
}
class AtcFind extends TreeItem {
    children: AtcFind[] = []
    constructor(public readonly finding: AtcWLFinding, public readonly parent: AtcObject, public readonly uri: string, public readonly start?: Position) {
        super(finding.checkTitle, TreeItemCollapsibleState.None)
        if (finding.quickfixInfo)
            this.iconPath = new ThemeIcon("issue-opened", new ThemeColor("list.warningForeground"))
        else
            this.iconPath = new ThemeIcon("check", new ThemeColor("notebookStatusSuccessIcon.foreground"))
        this.description = finding.messageTitle
        this.command = {
            title: "Open",
            command: AbapFsCommands.openLocation,
            arguments: [uri, start]
        }
    }
}

type AtcNode = AtcRoot | AtcSystem | AtcObject | AtcFind
class AtcProvider implements TreeDataProvider<AtcNode>{
    emitter = new EventEmitter<AtcNode | undefined>()
    root = new AtcRoot("systems", this)
    get onDidChangeTreeData() {
        return this.emitter.event
    }
    getTreeItem(element: AtcNode): AtcNode {
        return element
    }
    async getChildren(element?: AtcNode): Promise<AtcNode[]> {
        return element ? element.children : this.root.children
    }

    public markers(uri: Uri) {
        const system = this.root.systems.get(uri.authority)
        const findings: FindingMarker[] = []
        if (system) {
            const us = uri.toString()
            for (const object of system.children) {
                for (const finding of object.children) {
                    if (finding.uri === us && finding.start) findings.push({ uri: finding.uri, finding: finding.finding, start: finding.start })
                }
            }
        }
        return findings
    }

    async runInspector(uri: Uri, client: ADTClient) {
        const system = await this.root.child(uri.authority, () => getVariant(client, uri.authority))
        const worklist = await runInspector(uri, system.variant, client)
        await system.setWorklist(worklist)
        triggerUpdateDecorations()
        this.emitter.fire(system)
        commands.executeCommand("abapfs.atcFinds.focus")
    }

    @command(AbapFsCommands.openLocation)
    private async OpenLocation(uri: string, pos?: Position) {
        try {
            const uriP = Uri.parse(uri)
            const document = await workspace.openTextDocument(uriP)
            const doc = await window.showTextDocument(document, { preserveFocus: false })
            if (pos) doc.selection = new Selection(pos, pos)
        } catch (error) {
            showErrorMessage(error)
        }
    }
}

export const atcProvider = new AtcProvider()
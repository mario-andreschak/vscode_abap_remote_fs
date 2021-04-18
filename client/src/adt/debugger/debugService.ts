import {
    ADTClient, Debuggee, DebugStepType, isDebuggerBreakpoint,
    debugMetaIsComplex, isDebugListenerError, session_types
} from "abap-adt-api";
import { newClientFromKey, md5 } from "./functions";
import { readFileSync } from "fs";
import { createAdtUri, log } from "../../lib";
import { DebugProtocol } from "vscode-debugprotocol";
import { Disposable, EventEmitter, Uri } from "vscode";
import { getRoot } from "../conections";
import { isAbapFile, } from "abapfs";
import { homedir } from "os";
import { join } from "path";
import { Breakpoint, Handles, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent } from "vscode-debugadapter";
import { vsCodeUri } from "../../langClient";

export interface DebuggerUI {
    Confirmator: (message: string) => Thenable<boolean>
    ShowError: (message: string) => any
}
interface Variable {
    id: string,
    name: string
}


export class DebugService {
    private active: boolean = false;
    private listening = false
    private ideId: string;
    private username: string
    private notifier: EventEmitter<DebugProtocol.Event> = new EventEmitter()
    private listeners: Disposable[] = []
    private stackTrace: StackFrame[] = [];
    private breakpoints = new Map<string, Breakpoint[]>()
    private variableHandles = new Handles<Variable>();
    public readonly THREADID = 1;
    scopes: Scope[] = [];

    constructor(private connId: string, private client: ADTClient, private terminalId: string, private ui: DebuggerUI) {
        this.ideId = md5(connId)
        this.username = client.username.toUpperCase()
    }
    addListener(listener: (e: DebugProtocol.Event) => any, thisArg?: any) {
        return this.notifier.event(listener, thisArg, this.listeners)
    }

    getStack() {
        return this.stackTrace
    }

    async getScopes() {
        if (!this.scopes.length) {
            const { hierarchies } = await this.client.debuggerChildVariables(["@ROOT"])
            this.scopes = hierarchies.map(h => {
                const name = h.CHILD_NAME || h.CHILD_ID
                const handler = this.variableHandles.create({ id: h.CHILD_ID, name })
                return new Scope(name, handler, true)
            })
        }
        return this.scopes
    }

    async getVariables(parentid: number) {
        const vari = this.variableHandles.get(parentid)
        if (vari) {
            const children = await this.client.debuggerChildVariables([vari.id])
            const variables: DebugProtocol.Variable[] = children.variables.map(v => ({
                name: `${v.NAME}`,
                value: debugMetaIsComplex(v.META_TYPE) ? v.META_TYPE : `${v.VALUE}`,
                variablesReference: debugMetaIsComplex(v.META_TYPE) ? this.variableHandles.create({ name: v.NAME, id: v.ID }) : 0,
                memoryReference: `${v.ID}`
            }))
            return variables
        }
        return []
    }

    public static async create(connId: string, ui: DebuggerUI) {
        const client = await newClientFromKey(connId)
        if (!client) throw new Error(`Unable to create client for${connId}`);
        client.stateful = session_types.stateful
        await client.adtCoreDiscovery()
        const cfgfile = join(homedir(), ".SAP/ABAPDebugging/terminalId")
        const terminalId = readFileSync(cfgfile).toString("utf8")// "71999B60AA6349CF91D0A23773B3C728"
        return new DebugService(connId, client, terminalId, ui)
    }

    private stopListener(norestart = true) {
        if (norestart) {
            this.active = false
        }
        return this.client.statelessClone.debuggerDeleteListener("user", this.terminalId, this.ideId, this.username)
    }

    public async mainLoop() {
        this.active = true
        while (this.active) {
            try {
                // const foo = await this.client.statelessClone.debuggerListeners("user", this.terminalId, this.ideId, this.username)
                // log(JSON.stringify(foo))
                this.listening = true
                const debuggee = await this.client.statelessClone.debuggerListen("user", this.terminalId, this.ideId, this.username)
                    .finally(() => this.listening = false)
                if (!debuggee || !this.active) continue
                if (isDebugListenerError(debuggee)) {
                    // reconnect
                    break
                }
                await this.onBreakpointReached(debuggee)
            } catch (error) {
                if (!this.active) return
                if (error.properties["com.sap.adt.communicationFramework.subType"]) {
                    const txt = error?.properties?.conflictText || "Debugger conflict detected"
                    const message = `${txt} Take over debugging?`
                    // const resp = await window.showQuickPick(["YES", "NO"], { placeHolder })
                    const resp = await this.ui.Confirmator(message)
                    if (resp)
                        try {
                            await this.stopListener(false)
                        } catch (error2) {
                            log(JSON.stringify(error2))
                        }
                    else {
                        this.notifier.fire(new TerminatedEvent(false))
                        this.active = false
                    }
                }
                else {
                    this.ui.ShowError(`Error listening to debugger: ${error.message || error}`)
                    this.notifier.fire(new TerminatedEvent(false))
                    this.active = false
                }
            }
        }
    }

    public getBreakpoints(path: string) {
        return this.breakpoints.get(path) || [];
    }
    public async setBreakpoints(source: DebugProtocol.Source, breakpoints: DebugProtocol.SourceBreakpoint[]) {
        const bps = await this.setBreakpointsInt(source, breakpoints)
        if (source.path) this.breakpoints.set(source.path, bps)
        return bps
    }

    private async setBreakpointsInt(source: DebugProtocol.Source, breakpoints: DebugProtocol.SourceBreakpoint[]) {
        breakpoints ||= []
        if (!source.path) return []
        const uri = Uri.parse(source.path)
        const root = getRoot(this.connId)
        const node = await root.getNodeAsync(uri.path)
        if (isAbapFile(node)) {
            const objuri = node.object.contentsPath()
            const clientId = `24:${this.connId}${uri.path}` // `582:/A4H_001_developer_en/.adt/programs/programs/ztest/ztest.asprog`
            const bps = breakpoints.map(b => `${objuri}#start=${b.line}`)
            try {
                const actualbps = await this.client.statelessClone.debuggerSetBreakpoints(
                    "user", this.terminalId, this.ideId, clientId, bps, this.username)
                return breakpoints.map(bp => {
                    const actual = actualbps.find(a => isDebuggerBreakpoint(a) && a.uri.range.start.line === bp.line)
                    if (actual) {
                        const src = new Source(source.name || "", source.path)
                        return new Breakpoint(true, bp.line, 0, src)
                    }
                    return new Breakpoint(false)
                })
            } catch (error) {
                log(error.message)
            }
        }
        return []

    }

    private async onBreakpointReached(debuggee: Debuggee) {
        try {
            const attach = await this.client.debuggerAttach("user", debuggee.DEBUGGEE_ID, this.username, true)
            const bp = attach.reachedBreakpoints[0]
            await this.updateStack()
            this.notifier.fire(new StoppedEvent("breakpoint", this.THREADID))
        } catch (error) {
            log(`${error}`)
            this.stopDebugging()
        }
    }

    private async baseDebuggerStep(stepType: DebugStepType, url?: string) {
        if (stepType === "stepRunToLine" || stepType === "stepJumpToLine") {
            if (!url) throw new Error(`Bebugger step${stepType} requires a target`)
            return this.client.debuggerStep(stepType, url)
        }
        return this.client.debuggerStep(stepType)

    }

    public async debuggerStep(stepType: DebugStepType, url?: string) {
        try {
            const res = await this.baseDebuggerStep(stepType, url)
            if (res.isSteppingPossible) {
                await this.updateStack()
                this.notifier.fire(new StoppedEvent("breakpoint", this.THREADID))
            }
            return res
        } catch (error) {
            if (error.properties["com.sap.adt.communicationFramework.subType"] === "debuggeeEnded") {
                this.stopDebugging()
            } else
                this.ui.ShowError(error.message)
        }
    }

    private async updateStack() {
        const stackInfo = await this.client.debuggerStackTrace().catch(() => undefined)
        const createFrame = (path: string, line: number, id: number) => {
            const name = path.replace(/.*\//, "")
            // const fullPath = createAdtUri(this.connId, path).toString()
            const source = new Source(name, path)
            const frame = new StackFrame(id, name, source, line)
            return frame
        }
        if (stackInfo) {
            const root = getRoot(this.connId)
            const stackp = stackInfo.stack.map(async (s, id) => {
                try {
                    const path = await vsCodeUri(this.connId, s.uri.uri, false, true)
                    return createFrame(path, s.line, id)
                } catch (error) {
                    log(error)
                    return createFrame("unknown", 0, id)
                }
            })
            // @ts-ignore
            this.stackTrace = (await Promise.all(stackp)).filter(s => s instanceof StackFrame)
        }
    }

    public async stopDebugging() {
        this.active = false
        this.notifier.fire(new TerminatedEvent())
    }
    public async logout() {
        const ignore = () => undefined
        this.active = false
        const proms: Promise<any>[] = []
        if (this.listening) proms.push(this.stopListener().catch(ignore))
        if (this.client.loggedin)
            proms.push(this.client.dropSession().catch(ignore).then(() => this.client.logout().catch(ignore)))
        await Promise.all(proms)
    }
}

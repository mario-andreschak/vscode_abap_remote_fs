import { PACKAGE, AdtObjectCreator } from "../adt/operations/AdtObjectCreator"
import {
  workspace,
  Uri,
  window,
  commands,
  ViewColumn,
  ProgressLocation
} from "vscode"
import { pickAdtRoot, RemoteManager } from "../config"
import { log } from "../lib"
import { FavouritesProvider, FavItem } from "../views/favourites"
import { findEditor } from "../langClient"
import { showHideActivate } from "../listeners"
import { abapUnit } from "../adt/operations/UnitTestRunner"
import { selectTransport } from "../adt/AdtTransports"
import { showInGuiCb, executeInGui, runInSapGui } from "../adt/sapgui/sapgui"
import { storeTokens } from "../oauth"
import { showAbapDoc } from "../views/help"
import { showQuery } from "../views/query/query"
import { getTestAdapter } from "../views/abapunit"
import {
  ADTSCHEME,
  getClient,
  getRoot,
  uriRoot,
  getOrCreateRoot
} from "../adt/conections"
import { isAbapFolder, isAbapFile, isAbapStat } from "abapfs"
import { AdtObjectActivator } from "../adt/operations/AdtObjectActivator"
import {
  AdtObjectFinder,
  createUri,
  findAbapObject
} from "../adt/operations/AdtObjectFinder"
import { isAbapClassInclude } from "abapobject"
import { IncludeProvider } from "../adt/includes" // resolve dependencies
import { command, AbapFsCommands } from "."
import { createConnection } from "./connectionwizard"

function currentUri() {
  if (!window.activeTextEditor) return
  const uri = window.activeTextEditor.document.uri
  if (uri.scheme !== ADTSCHEME) return
  return uri
}

function current() {
  const uri = currentUri()
  if (!uri) return
  const client = getClient(uri.authority)
  return { uri, client }
}

export function openObject(connId: string, uri: string) {
  return window.withProgress(
    { location: ProgressLocation.Window, title: "Opening..." },
    async () => {
      const root = getRoot(connId)
      const { file, path } = (await root.findByAdtUri(uri, true)) || {}
      if (!file || !path) throw new Error("Object not found in workspace")
      if (isAbapFolder(file) && file.object.type === PACKAGE) {
        await commands.executeCommand(
          "revealInExplorer",
          createUri(connId, path)
        )
        return
      } else if (isAbapFile(file))
        await workspace
          .openTextDocument(createUri(connId, path))
          .then(window.showTextDocument)
      return { file, path }
    }
  )
}

export class AdtCommands {
  @command(AbapFsCommands.showDocumentation)
  private static async showAbapDoc() {
    return showAbapDoc()
  }

  @command(AbapFsCommands.selectDB)
  private static async selectDB() {
    return showQuery()
  }

  @command(AbapFsCommands.changeInclude)
  private static async changeMain(uri: Uri) {
    return IncludeProvider.get().switchInclude(uri)
  }

  @command(AbapFsCommands.createConnection)
  private static createConnectionCommand() {
    return createConnection()
  }

  @command(AbapFsCommands.connect)
  private static async connectAdtServer(selector: any) {
    let name = ""
    try {
      const connectionID = selector && selector.connection
      const manager = RemoteManager.get()
      const { remote, userCancel } = await manager.selectConnection(
        connectionID
      )
      if (!remote)
        if (!userCancel)
          throw Error("No remote configuration available in settings")
        else return
      name = remote.name

      log(`Connecting to server ${remote.name}`)
      // this might involve asking for a password...
      await getOrCreateRoot(remote.name) // if connection raises an exception don't mount any folder

      await storeTokens()

      workspace.updateWorkspaceFolders(0, 0, {
        uri: Uri.parse("adt://" + remote.name),
        name: remote.name + "(ABAP)"
      })

      log(`Connected to server ${remote.name}`)
    } catch (e) {
      if (e.response) log(e.response.body)
      const isMissing = (e: any) =>
        !!`${e}`.match("name.*org.freedesktop.secrets")
      const message = isMissing(e)
        ? `Password storage not supported. Please install gnome-keyring or add a password to the connection`
        : `Failed to connect to ${name}:${e.toString()}`
      return window.showErrorMessage(message)
    }
  }

  @command(AbapFsCommands.activate)
  private static async activateCurrent(selector: Uri) {
    try {
      const uri = selector || currentUri()
      const activator = AdtObjectActivator.get(uri.authority)
      const editor = findEditor(uri.toString())
      await window.withProgress(
        { location: ProgressLocation.Window, title: "Activating..." },
        async () => {
          const obj = findAbapObject(uri)
          // if editor is dirty, save before activate
          if (editor && editor.document.isDirty) {
            const saved = await editor.document.save()
            if (!saved) return
          }
          await activator.activate(obj, uri)
          if (editor === window.activeTextEditor) {
            await obj.loadStructure() // TODO replace with stat?
            await showHideActivate(editor)
          }
        }
      )
    } catch (e) {
      return window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.runClass)
  private static async runClass() {
    try {
      const uri = currentUri()
      if (!uri) return
      const client = getClient(uri.authority)
      const fsRoot = await pickAdtRoot(uri)
      if (!fsRoot) return
      const file = uriRoot(fsRoot.uri).getNode(uri.path)
      const clas = isAbapFile(file) && isAbapClassInclude(file.object) && file.object.parent
      if (clas) {
        const text = await client.runClass(clas.name)
        log(text)
      }
    } catch (error) {
      log(error)
    }

  }

  @command(AbapFsCommands.search)
  private static async searchAdtObject(uri: Uri | undefined) {
    // find the adt relevant namespace roots, and let the user pick one if needed
    const adtRoot = await pickAdtRoot(uri)
    if (!adtRoot) return
    try {
      const connId = adtRoot.uri.authority
      const object = await new AdtObjectFinder(connId).findObject()
      if (!object) return // user cancelled
      // found, show progressbar as opening might take a while
      await openObject(connId, object.uri)
    } catch (e) {
      return window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.create)
  private static async createAdtObject(uri: Uri | undefined) {
    try {
      // find the adt relevant namespace roots, and let the user pick one if needed
      const fsRoot = await pickAdtRoot(uri)
      const connId = fsRoot?.uri.authority
      if (!connId) return
      const obj = await new AdtObjectCreator(connId).createObject(uri)
      if (!obj) return // user aborted
      log(`Created object ${obj.type} ${obj.name}`)

      if (obj.type === PACKAGE) {
        commands.executeCommand("workbench.files.action.refreshFilesExplorer")
        return // Packages can't be opened perhaps could reveal it?
      }
      const nodePath = await openObject(connId, obj.path)
      if (nodePath) {
        new AdtObjectFinder(connId).displayNode(nodePath)
        try {
          await commands.executeCommand(
            "workbench.files.action.refreshFilesExplorer"
          )
          log("workspace refreshed")
        } catch (e) {
          log("error refreshing workspace")
        }
      }
    } catch (e) {
      log("Exception in createAdtObject:", e.stack)
      return window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.runInGui)
  private static async executeAbap() {
    try {
      log("Execute ABAP")
      const uri = currentUri()
      if (!uri) return
      const fsRoot = await pickAdtRoot(uri)
      if (!fsRoot) return
      const file = uriRoot(fsRoot.uri).getNode(uri.path)
      if (!isAbapStat(file) || !file.object.sapGuiUri) return
      await executeInGui(fsRoot.uri.authority, file.object)

    } catch (e) {
      return window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.execute)
  private static async openInGuiAbap() {
    try {
      log("Open ABAP in GUI")
      const uri = currentUri()
      if (!uri) return
      const fsRoot = await pickAdtRoot(uri)
      if (!fsRoot) return
      const file = uriRoot(fsRoot.uri).getNode(uri.path)
      if (!isAbapStat(file) || !file.object.sapGuiUri) return
      await runInSapGui(fsRoot.uri.authority, showInGuiCb(file.object.sapGuiUri))
    } catch (e) {
      return window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.addfavourite)
  private static addFavourite(uri: Uri | undefined) {
    // find the adt relevant namespace roots, and let the user pick one if needed
    if (uri) FavouritesProvider.get().addFavourite(uri)
  }

  @command(AbapFsCommands.deletefavourite)
  private static deleteFavourite(node: FavItem) {
    FavouritesProvider.get().deleteFavourite(node)
  }

  @command(AbapFsCommands.unittest)
  private static async runAbapUnit() {
    try {
      log("Execute ABAP Unit tests")
      const uri = currentUri()
      if (!uri) return

      const adapter = getTestAdapter(uri)
      await window.withProgress(
        { location: ProgressLocation.Window, title: "Running ABAP UNIT" },
        () => adapter ? adapter.runUnit(uri) : abapUnit(uri)
      )
    } catch (e) {
      return window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.createtestinclude)
  private static createTestInclude(uri?: Uri) {
    if (uri) {
      if (uri.scheme !== ADTSCHEME) return
      return this.createTI(uri)
    }
    const cur = current()
    if (!cur) return
    return this.createTI(cur.uri)
  }

  @command(AbapFsCommands.clearPassword)
  public static async clearPasswordCmd(connectionId?: string) {
    return RemoteManager.get().clearPasswordCmd(connectionId)
  }

  private static async createTI(uri: Uri) {
    const obj = await findAbapObject(uri)
    // only makes sense for classes
    if (!isAbapClassInclude(obj)) return
    if (!obj.parent) return
    if (obj.parent.structure) await obj.loadStructure()
    if (obj.parent.findInclude("testclasses"))
      return window.showInformationMessage("Test include already exists")

    const m = uriRoot(uri).lockManager
    const lock = await m.requestLock(uri.path)
    const lockId = lock.status === "locked" && lock.LOCK_HANDLE
    if (!lockId) {
      throw new Error(`Can't acquire a lock for ${obj.name}`)
    }
    try {
      let created
      const client = getClient(uri.authority)

      const transport = await selectTransport(
        obj.contentsPath(),
        "",
        client,
        true
      )
      if (transport.cancelled) return
      const parentName = obj.parent.name
      await client.createTestInclude(parentName, lockId, transport.transport)
      created = true

      // TODO locking logic
      // If I created the lock I remove it. Possible race condition here...
      if (lock) await m.requestUnlock(uri.path)
      if (created) {
        if (window.activeTextEditor)
          showHideActivate(window.activeTextEditor, true)
        commands.executeCommand("workbench.files.action.refreshFilesExplorer")
      }
    } catch (e) {
      if (lock) await m.requestUnlock(uri.path)
      log(e.toString())
      window.showErrorMessage(`Error creating class include`)
    }
  }
}

import { getOrCreateRoot } from "../adt/conections"
import {
  FileSystemError,
  FileChangeType,
  FileSystemProvider,
  EventEmitter,
  FileChangeEvent,
  Uri,
  Disposable,
  FileStat,
  FileType
} from "vscode"
import { caughtToString, log } from "../lib"
import { isAbapFile, isAbapFolder, isFolder } from "abapfs"
import { getObjectTypeFromPath, getObjectNameFromPath, validateObjectName, getDefaultContent } from "../lib/objectTypes"
import { selectTransportIfNeeded } from "../adt/AdtTransports"
import { create } from "abapObject"

export class FsProvider implements FileSystemProvider {
  private static instance: FsProvider
  public static get() {
    if (!FsProvider.instance) FsProvider.instance = new FsProvider()
    return FsProvider.instance
  }
  public get onDidChangeFile() {
    return this.pEventEmitter.event
  }
  private pEventEmitter = new EventEmitter<FileChangeEvent[]>()
  public watch(): Disposable {
    return new Disposable(() => undefined)
  }

  public notifyChanges(changes: FileChangeEvent[]) {
    this.pEventEmitter.fire(changes)
  }

  public async stat(uri: Uri): Promise<FileStat> {
    // no .* files allowed here, no need to log that
    if (uri.path.match(/(^\.)|(\/\.)/)) throw FileSystemError.FileNotFound(uri)
    try {
      const root = await getOrCreateRoot(uri.authority)
      const node = await root.getNodeAsync(uri.path)
      if (!node) throw FileSystemError.FileNotFound(uri)
      if (isAbapFile(node)) await node.stat()
      if (isAbapFolder(node)) await node.refresh()
      return node
    } catch (e) {
      log(`Error in stat of ${uri?.toString()}\n${caughtToString(e)}`)
      throw e
    }
  }

  public async readFile(uri: Uri): Promise<Uint8Array> {
    try {
      const root = await getOrCreateRoot(uri.authority)
      const node = await root.getNodeAsync(uri.path)
      if (isAbapFile(node)) {
        const contents = await node.read()
        const buf = Buffer.from(contents)
        return buf
      }
    } catch (error) {
      log(`Error reading file ${uri?.toString()}\n${caughtToString(error)}`)
    }
    throw FileSystemError.Unavailable(uri)
  }

  public async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    try {
      const root = await getOrCreateRoot(uri.authority)
      const node = await root.getNodeAsync(uri.path)
      if (!isFolder(node)) throw FileSystemError.FileNotFound(uri)
      if (isAbapFolder(node) && node.size === 0) await node.refresh()
      return [...node].map(i => [i.name, i.file.type])
    } catch (e) {
      log(`Error reading directory ${uri?.toString()}\n${caughtToString(e)}`)
      throw e
    }
  }

  public createDirectory(uri: Uri): void | Thenable<void> {
    throw FileSystemError.NoPermissions(
      "Not a real filesystem, directory creation is not supported"
    )
  }

  public async writeFile(uri: Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
    try {
      const root = await getOrCreateRoot(uri.authority)
      let node = await root.getNodeAsync(uri.path)

      // Handle new file creation
      if (!node && options.create) {
        try {
          // Get object type and name from path
          const objectType = getObjectTypeFromPath(uri.path)
          const objectName = getObjectNameFromPath(uri.path)

          // Validate object name
          if (!validateObjectName(objectName)) {
            throw FileSystemError.NoPermissions(
              "Invalid ABAP object name. Must start with Y or Z and contain only A-Z, 0-9, _"
            )
          }

          // Get transport assignment
          const trsel = await selectTransportIfNeeded(uri)
          if (trsel.cancelled) return

          // Create the ABAP object
          const service = root.service
          const newObject = await create(
            objectType.adtType,
            objectName,
            `/sap/bc/adt/${objectType.category.toLowerCase()}/${objectType.category.toLowerCase()}`,
            false,
            "",
            undefined,
            "",
            service
          )

          // Initialize with default content
          const defaultContent = getDefaultContent(objectName, objectType)
          const lock = await root.lockManager.requestLock(uri.path)
          if (lock.status !== "locked") {
            throw FileSystemError.NoPermissions("Unable to acquire lock for new object")
          }

          await newObject.write(defaultContent, lock.LOCK_HANDLE, trsel.transport)
          await root.lockManager.requestUnlock(uri.path, true)

          // Refresh to get the new node
          node = await root.getNodeAsync(uri.path)
          if (!node) throw FileSystemError.FileNotFound(uri)

          // Notify about the creation
          this.pEventEmitter.fire([{ type: FileChangeType.Created, uri }])
        } catch (error: any) {
          const errorMessage = error.message || "Unknown error occurred"
          throw FileSystemError.NoPermissions(
            `Failed to create ABAP object: ${errorMessage}`
          )
        }
      }

      // Handle write operation
      if (isAbapFile(node)) {
        const trsel = await selectTransportIfNeeded(uri)
        if (trsel.cancelled) return
        const lock = root.lockManager.lockStatus(uri.path)
        if (lock.status === "locked") {
          await node.write(
            content.toString(),
            lock.LOCK_HANDLE,
            trsel.transport
          )
          await root.lockManager.requestUnlock(uri.path, true)
          this.pEventEmitter.fire([{ type: FileChangeType.Changed, uri }])
        } else throw new Error(`File ${uri.path} was not locked`)
      } else throw FileSystemError.FileNotFound(uri)
    } catch (e) {
      log(`Error writing file ${uri.toString()}\n${caughtToString(e)}`)
      throw e
    }
  }

  public async delete(uri: Uri, options: { recursive: boolean }) {
    try {
      const root = await getOrCreateRoot(uri.authority)
      const node = await root.getNodeAsync(uri.path)
      const lock = await root.lockManager.requestLock(uri.path)
      if (lock.status === "locked") {
        const trsel = await selectTransportIfNeeded(uri)
        if (trsel.cancelled) return
        if (isAbapFolder(node) || isAbapFile(node))
          return await node.delete(lock.LOCK_HANDLE, trsel.transport)
        else
          throw FileSystemError.Unavailable(
            "Deletion not supported for this object"
          )
      } else throw FileSystemError.NoPermissions(`Unable to acquire lock`)
    } catch (e) {
      const msg = `Error deleting file ${uri.toString()}\n${caughtToString(e)}`
      log(msg)
      throw new Error(msg)
    }
  }

  public rename(
    oldUri: Uri,
    newUri: Uri,
    options: { overwrite: boolean }
  ): void | Thenable<void> {
    throw new Error("Method not implemented.")
  }
}

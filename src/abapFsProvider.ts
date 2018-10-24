import * as vscode from "vscode"
import { AdtPathManager } from "./adt/AdtPathManager"

export class AbapFsProvider implements vscode.FileSystemProvider {
  private _pathManager = new AdtPathManager()
  private _eventEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this
    ._eventEmitter.event
  watch(
    uri: vscode.Uri,
    options: { recursive: boolean; excludes: string[] }
  ): vscode.Disposable {
    throw new Error("Method not implemented.")
  }
  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    return this._pathManager.fetchFileOrDir(uri)
  }
  readDirectory(
    uri: vscode.Uri
  ): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    const result: [string, vscode.FileType][] = []
    const dir = this._pathManager.getDirectory(uri)
    if (dir)
      Array.from(dir.entries).forEach(([key, value]) =>
        result.push([key.replace(/\//g, "_"), value.type])
      )
    return result
  }
  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    throw new Error("Method not implemented.")
  }
  readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
    const file = this._pathManager.find(uri)
    if (file && file.body) return file.body
    return new Uint8Array([])
  }
  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): void | Thenable<void> {
    throw new Error("Method not implemented.")
  }
  delete(
    uri: vscode.Uri,
    options: { recursive: boolean }
  ): void | Thenable<void> {
    throw new Error("Method not implemented.")
  }
  rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean }
  ): void | Thenable<void> {
    throw new Error("Method not implemented.")
  }
}

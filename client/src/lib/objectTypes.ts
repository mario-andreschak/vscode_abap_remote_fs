import { FileSystemError } from "vscode"

export interface AbapObjectType {
    fileExtension: string    // e.g., .prog.abap
    adtType: string         // e.g., PROG/P
    category: string        // e.g., Programs
    template: string        // Default content template
}

export const ABAP_OBJECT_TYPES: { [key: string]: AbapObjectType } = {
    "program": {
        fileExtension: ".prog.abap",
        adtType: "PROG/P",
        category: "Programs",
        template: `REPORT ##OBJECT_NAME##.
`
    },
    "class": {
        fileExtension: ".clas.abap",
        adtType: "CLAS/OC",
        category: "Classes",
        template: `CLASS ##OBJECT_NAME## DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS ##OBJECT_NAME## IMPLEMENTATION.
ENDCLASS.`
    },
    "interface": {
        fileExtension: ".intf.abap",
        adtType: "INTF/OI",
        category: "Interfaces",
        template: `INTERFACE ##OBJECT_NAME##
  PUBLIC.
ENDINTERFACE.`
    }
}

export function getObjectTypeFromPath(path: string): AbapObjectType {
    for (const type of Object.values(ABAP_OBJECT_TYPES)) {
        if (path.toLowerCase().endsWith(type.fileExtension)) {
            return type
        }
    }
    throw FileSystemError.FileNotFound(`Unsupported ABAP object type for path: ${path}`)
}

export function getObjectNameFromPath(path: string): string {
    const parts = path.split('/')
    if (parts.length === 0) {
        throw FileSystemError.FileNotFound("Invalid path: empty path")
    }
    const filename = parts[parts.length - 1]
    if (!filename) {
        throw FileSystemError.FileNotFound("Invalid path: no filename")
    }
    const objectType = getObjectTypeFromPath(path)
    return filename.replace(objectType.fileExtension, '')
}

export function getDefaultContent(objectName: string, type: AbapObjectType): string {
    return type.template.replace(/##OBJECT_NAME##/g, objectName)
}

export function validateObjectName(name: string): boolean {
    // ABAP naming rules:
    // - Must start with Y or Z for custom objects
    // - Can contain A-Z, 0-9, and _
    // - Maximum 30 characters
    return /^[YZ][A-Z0-9_]{0,29}$/.test(name)
}

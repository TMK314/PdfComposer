export interface UndoableCommand {
    /** Nur für Debug-Zwecke / spätere Anzeige, z.B. in einer History-Liste. */
    label?: string;
    undo(): void | Promise<void>;
    redo(): void | Promise<void>;
}

export class UndoManager {
    private undoStack: UndoableCommand[] = [];
    private redoStack: UndoableCommand[] = [];
    private readonly maxSize: number;

    /** Verhindert, dass während undo()/redo() ausgeführte Schreibvorgänge erneut auf den Stack gepusht werden. */
    private isApplying: boolean = false;

    constructor(maxSize: number = 200) {
        this.maxSize = maxSize;
    }

    /** Legt einen neuen Command ab. Löscht dabei den Redo-Stack (neue Aktion nach einem Undo). */
    push(command: UndoableCommand): void {
        if (this.isApplying) return;
        this.undoStack.push(command);
        if (this.undoStack.length > this.maxSize) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    }

    async undo(): Promise<void> {
        const command = this.undoStack.pop();
        if (!command) return;
        this.isApplying = true;
        try {
            await command.undo();
        } finally {
            this.isApplying = false;
        }
        this.redoStack.push(command);
    }

    async redo(): Promise<void> {
        const command = this.redoStack.pop();
        if (!command) return;
        this.isApplying = true;
        try {
            await command.redo();
        } finally {
            this.isApplying = false;
        }
        this.undoStack.push(command);
    }

    canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /** Muss beim Wechsel der Datei aufgerufen werden – alte Commands referenzieren die alte Datei/Seiten. */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }
}
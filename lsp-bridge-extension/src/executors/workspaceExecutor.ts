import * as vscode from 'vscode';
import { ExecutionResult, StepOperation, ValidationFailure, WorkflowStep, WorkspaceOperation } from '../execution/ir';
import { WorkflowExecutionContext, WorkflowExecutor } from '../execution/context';
import { buildEditForOperation, OperationError } from '../workspace/workspaceEditBuilder';
import { formatDocument } from '../workspace/formatter';
import { SymbolResolutionError } from '../workspace/symbolResolver';

// Applies a `workspace` step's operations, one at a time. Deterministic: it never
// reasons. Each op is built against the CURRENT buffer (see workspaceEditBuilder),
// applied, then the touched files are formatted + saved before the next op — so an
// anchored op sees the file exactly as prior ops in the step left it. Any op error
// stops the step and returns a `failed` result, which the engine may repair (§10).

const WORKSPACE_OPS = new Set<StepOperation['operation']>([
  'replace_function',
  'replace_method',
  'replace_block',
  'replace_lines',
  'insert_before',
  'insert_after',
  'replace_text',
  'append',
  'prepend',
  'create_file',
  'delete_file',
  'rename_symbol',
  'add_import',
  'remove_import',
  'move_file',
]);

export class WorkspaceExecutor implements WorkflowExecutor {
  readonly kind = 'workspace' as const;

  supports(step: WorkflowStep): boolean {
    return step.executor === 'workspace';
  }

  async execute(step: WorkflowStep, ctx: WorkflowExecutionContext): Promise<ExecutionResult> {
    const touched = new Set<string>();
    const ops = step.script.filter((o): o is WorkspaceOperation => WORKSPACE_OPS.has(o.operation));

    for (const op of ops) {
      if (ctx.token.isCancellationRequested) {
        return { stepId: step.id, status: 'skipped', message: 'cancelled', editedFiles: [...touched] };
      }
      try {
        const built = await buildEditForOperation(op, ctx.workspaceRoot);
        // Capture originals before mutating, so Undo can revert exactly these files.
        await ctx.snapshotFiles(built.files);
        const applied = await vscode.workspace.applyEdit(built.edit);
        if (!applied) {
          return fail(step, touched, {
            kind: 'apply_failed',
            message: `VS Code rejected the edit for: ${built.note}`,
          });
        }
        for (const file of built.files) {
          touched.add(file);
          await saveAndFormat(file);
        }
        ctx.progress.info(`✔ ${built.note}`);
      } catch (err) {
        return fail(step, touched, toFailure(err));
      }
    }

    return { stepId: step.id, status: 'succeeded', editedFiles: [...touched] };
  }
}

// Format then persist a file that an edit touched. Deleted/moved-away files can't
// be opened — skip them silently.
async function saveAndFormat(fsPath: string): Promise<void> {
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
  } catch {
    return; // file no longer exists (delete_file / move_file source)
  }
  await formatDocument(doc);
  if (doc.isDirty) {
    await doc.save();
  }
}

function fail(step: WorkflowStep, touched: Set<string>, failure: ValidationFailure): ExecutionResult {
  return { stepId: step.id, status: 'failed', failure, editedFiles: [...touched] };
}

function toFailure(err: unknown): ValidationFailure {
  if (err instanceof OperationError) return { kind: err.kind, message: err.message };
  if (err instanceof SymbolResolutionError) return { kind: err.kind, message: err.message };
  return { kind: 'operation_error', message: err instanceof Error ? err.message : String(err) };
}

import * as vscode from 'vscode';

// The surface the agent loop writes to. runAgent() is otherwise already
// surface-agnostic, so this is all that stood between it and a second UI:
// the chat participant wraps a ChatResponseStream, the Foundry panel wraps
// webview postMessage. Only what the loop actually calls lives here —
// richer webview-only signals are optional so the chat adapter stays a
// two-line wrapper rather than a pile of no-ops.

export interface ToolActivity {
  tool: string; // full tool name, e.g. foundry_semanticSearch / apply_edit
  kind: 'lookup' | 'edit';
  label: string; // short human-readable line (same text chat shows as progress)
  input: Record<string, unknown>;
}

export interface AgentOutput {
  /** Answer text from the model, streamed as it arrives. */
  markdown(value: string): void;
  /** Transient status line ("Searching…"), superseded by the next one. */
  progress(value: string): void;
  /**
   * A tool call about to run. Chat has no place to put this beyond the
   * progress line it already gets, so the chat adapter omits it.
   */
  toolActivity?(activity: ToolActivity): void;
}

export function chatOutput(stream: vscode.ChatResponseStream): AgentOutput {
  return {
    markdown: (value) => stream.markdown(value),
    progress: (value) => stream.progress(value),
  };
}

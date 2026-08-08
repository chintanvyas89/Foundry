import * as vscode from 'vscode';
import type { ToolActivity } from '../executor/agentOutput';

// The panel's conversation, owned by the EXTENSION HOST rather than the webview.
//
// Two reasons it lives here and not in the DOM:
//  1. A WebviewView is disposed whenever the user collapses it or switches
//     Activity Bar containers. State kept in the DOM dies with it; state kept
//     here survives, and the webview re-renders from snapshot() on restore.
//  2. `messages` is the actual LanguageModelChatMessage array handed to
//     runAgent(), which mutates it in place (assistant turns + tool results).
//     Because the panel owns one continuous session instead of a sequence of
//     chat turns, that array simply persists between sends — the model keeps
//     full tool-level memory of what it already discovered, which is precisely
//     what the chat participant cannot do across a turn boundary.

export type EntryKind = 'user' | 'assistant' | 'tools' | 'notice';

export interface TranscriptEntry {
  id: string;
  kind: EntryKind;
  /** user / assistant / notice text. Assistant text accumulates as it streams. */
  text: string;
  /** Populated for `tools` entries — consecutive calls collapse into one group. */
  tools?: ToolActivity[];
}

export interface SessionSnapshot {
  entries: TranscriptEntry[];
  running: boolean;
}

export class PanelSession {
  /** Live LM message array — seeded once, then carried across every send. */
  readonly messages: vscode.LanguageModelChatMessage[] = [];
  private readonly entries: TranscriptEntry[] = [];
  private seeded = false;
  private nextId = 1;

  get isSeeded(): boolean {
    return this.seeded;
  }

  /** Push the preamble exactly once per session. */
  seed(preamble: string): void {
    if (this.seeded) return;
    this.messages.push(vscode.LanguageModelChatMessage.User(preamble));
    this.seeded = true;
  }

  snapshot(running: boolean): SessionSnapshot {
    return { entries: this.entries, running };
  }

  /**
   * A new user message: recorded for display AND appended to the live message
   * array, so the model sees it in the same conversation as everything before.
   */
  addUser(text: string): TranscriptEntry {
    this.messages.push(vscode.LanguageModelChatMessage.User(text));
    return this.push('user', text);
  }

  addNotice(text: string): TranscriptEntry {
    return this.push('notice', text);
  }

  /**
   * Streamed answer text. Appends to the trailing assistant entry when there is
   * one, so a single reply stays a single bubble; starts a new one after a tool
   * group, which is what makes think→act→think read in the right order.
   * Returns the entry plus whether the caller must render it as new.
   */
  appendAssistant(text: string): { entry: TranscriptEntry; isNew: boolean } {
    const last = this.entries[this.entries.length - 1];
    if (last?.kind === 'assistant') {
      last.text += text;
      return { entry: last, isNew: false };
    }
    return { entry: this.push('assistant', text), isNew: true };
  }

  /**
   * A tool call. Consecutive calls merge into one entry so the UI can render
   * "3 tools" collapsed rather than three separate rows of noise.
   */
  addTool(activity: ToolActivity): { entry: TranscriptEntry; isNew: boolean } {
    const last = this.entries[this.entries.length - 1];
    if (last?.kind === 'tools' && last.tools) {
      last.tools.push(activity);
      return { entry: last, isNew: false };
    }
    const entry = this.push('tools', '');
    entry.tools = [activity];
    return { entry, isNew: true };
  }

  private push(kind: EntryKind, text: string): TranscriptEntry {
    const entry: TranscriptEntry = { id: `e${this.nextId++}`, kind, text };
    this.entries.push(entry);
    return entry;
  }
}

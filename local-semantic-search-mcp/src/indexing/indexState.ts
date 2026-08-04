// Shared, process-wide indexing status for lazy indexing. The search tool and
// repo_overview read it to report progress and to gate on `searchable` (which
// resolves once search can return useful results) rather than on the full build.
//
// Two gates:
//   - `searchable`  — the embedder is loaded AND the priority "hot set" of files
//     is embedded (or, for a non-building instance, the existing index is ready).
//     `semantic_search` awaits THIS, so search opens in seconds on a fresh repo.
//   - `indexComplete` — the whole workspace has been embedded. The opt-in
//     symbol/graph/usages/impls builds await this so they see every file.

export interface IndexStatus {
  building: boolean; // a background embedding pass is in progress
  filesDone: number; // files embedded/skipped so far this pass
  filesTotal: number; // files to process this pass
  percent: number; // 0–100 (100 when not building / complete)
}

export class IndexState {
  building = false;
  filesDone = 0;
  filesTotal = 0;

  private searchableResolve!: () => void;
  private searchableReject!: (err: unknown) => void;
  private completeResolve!: () => void;
  private completeReject!: (err: unknown) => void;
  readonly searchable: Promise<void>;
  readonly indexComplete: Promise<void>;

  constructor() {
    this.searchable = new Promise<void>((res, rej) => {
      this.searchableResolve = res;
      this.searchableReject = rej;
    });
    this.indexComplete = new Promise<void>((res, rej) => {
      this.completeResolve = res;
      this.completeReject = rej;
    });
    // The opt-in SWE_BUILD_* passes are the only awaiters of indexComplete and
    // only when a flag is set; swallow an otherwise-unhandled rejection so a
    // failed init doesn't crash the process (searchable still surfaces the error
    // to the search tool, which always awaits it).
    void this.indexComplete.catch(() => {});
  }

  beginBuild(total: number): void {
    this.building = true;
    this.filesTotal = total;
    this.filesDone = 0;
  }

  progress(done: number): void {
    this.filesDone = done;
  }

  markSearchable(): void {
    this.searchableResolve();
  }

  finishBuild(): void {
    this.building = false;
    this.filesDone = this.filesTotal;
    // A build that opened search late still must unblock both gates.
    this.searchableResolve();
    this.completeResolve();
  }

  // Startup (e.g. model load) failed — surface it to search instead of hanging.
  failInit(err: unknown): void {
    this.building = false;
    this.searchableReject(err);
    this.completeReject(err);
  }

  status(): IndexStatus {
    const percent =
      !this.building || this.filesTotal === 0
        ? 100
        : Math.min(100, Math.round((this.filesDone / this.filesTotal) * 100));
    return {
      building: this.building,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
      percent,
    };
  }
}

// One instance per server process.
export const indexState = new IndexState();

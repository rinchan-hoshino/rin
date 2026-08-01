export type RpcInputObservedRole = "terminalOwner" | "nonterminal";

export type RpcTurnPhase = "idle" | "running" | "interrupting";

export type RpcTurnInterrupt = Readonly<{ id: number; epoch: number }>;

export type RpcTurnAdmission = {
  readonly requestTag: string;
  readonly observedRole: RpcInputObservedRole;
  readonly text: string;
  readonly hasImages: boolean;
  readonly turn?: RpcTrackedTurn<unknown>;
  readonly started?: Promise<number | null>;
  readonly cancelled?: Promise<void>;
  resolveStarted?: (generation: number | null) => void;
  resolveCancelled?: () => void;
};

export type RpcUserStart = {
  requestTag: string;
  text: string;
  hasImages: boolean;
  message: unknown;
};

export type RpcUserStartMatch = {
  requestTag: string;
  admission: RpcTurnAdmission;
};

type RpcCoordinatorState<TSettlement> =
  | { phase: "idle" }
  | { phase: "running"; turn: RpcTrackedTurn<TSettlement> }
  | {
      phase: "interrupting";
      depth: number;
      turn?: RpcTrackedTurn<TSettlement>;
      active?: RpcTurnInterrupt;
    };

export class RpcTrackedTurn<TSettlement = unknown> {
  readonly admissions: RpcTurnAdmission[] = [];
  readonly cancelled: Promise<string>;
  readonly firstSettlement: Promise<TSettlement>;
  readonly completion: Promise<void>;
  settlementGeneration = 0;
  terminalConflict = false;
  onOwnedUserStart?: (message: unknown) => void;

  private readonly settlementWaiters = new Set<() => void>();
  private terminalKey = "";
  private resolveCancellation?: (reason: string) => void;
  private resolveFirstSettlement?: (outcome: TSettlement) => void;
  private resolveCompletion?: () => void;
  private rejectCompletion?: (error: unknown) => void;
  private settledAdmissionCount = 0;

  constructor(
    readonly requestTag: string,
    readonly turnGeneration: number,
  ) {
    this.cancelled = new Promise<string>((resolve) => {
      this.resolveCancellation = resolve;
    });
    this.firstSettlement = new Promise<TSettlement>((resolve) => {
      this.resolveFirstSettlement = resolve;
    });
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.completion.catch(() => {});
  }

  bindCompletion(completion: Promise<void>): void {
    completion.then(
      () => this.resolveCompletion?.(),
      (error) => this.rejectCompletion?.(error),
    );
  }

  commitTerminal(key: string, commit: () => void): boolean {
    if (this.terminalKey) {
      if (this.terminalKey !== key) this.terminalConflict = true;
      return false;
    }
    this.terminalKey = key;
    commit();
    return true;
  }

  observeAgentSettlement(outcome?: TSettlement): void {
    this.settlementGeneration += 1;
    for (const waiter of this.settlementWaiters) waiter();
    this.resolveFirstSettlement?.(outcome as TSettlement);
    this.resolveFirstSettlement = undefined;
  }

  cancel(reason = "Request was aborted"): void {
    this.resolveCancellation?.(reason);
    this.resolveCancellation = undefined;
  }

  async waitForContinuations(): Promise<boolean> {
    let startedAdmission = false;
    while (this.settledAdmissionCount < this.admissions.length) {
      const admissions = this.admissions.slice(this.settledAdmissionCount);
      const startedAtGenerations = await Promise.all(
        admissions.map(
          (admission) => admission.started || Promise.resolve(null),
        ),
      );
      this.settledAdmissionCount += admissions.length;
      const startedAdmissions = admissions.filter(
        (_admission, index) => startedAtGenerations[index] !== null,
      );
      const startedGenerations = startedAtGenerations.filter(
        (generation): generation is number => generation !== null,
      );
      if (startedGenerations.length > 0) {
        startedAdmission = true;
        const allStartedAdmissionsCancelled = Promise.all(
          startedAdmissions
            .map((admission) => admission.cancelled)
            .filter((cancelled): cancelled is Promise<void> =>
              Boolean(cancelled),
            ),
        ).then(() => undefined);
        await Promise.race([
          this.waitForSettlementAfter(Math.max(...startedGenerations)),
          allStartedAdmissionsCancelled,
        ]);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return startedAdmission;
  }

  private waitForSettlementAfter(generation: number): Promise<void> {
    if (this.settlementGeneration > generation) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = () => {
        if (this.settlementGeneration <= generation) return;
        this.settlementWaiters.delete(waiter);
        resolve();
      };
      this.settlementWaiters.add(waiter);
    });
  }
}

export class RpcTurnCoordinator<TSettlement = unknown> {
  private state: RpcCoordinatorState<TSettlement> = { phase: "idle" };
  private readonly pendingAdmissions: RpcTurnAdmission[] = [];
  private readonly admittedByTag = new Map<string, RpcInputObservedRole>();
  private readonly recentByTag = new Map<string, RpcInputObservedRole>();
  private readonly idleWaiters = new Set<() => void>();
  private interruptEpoch = 0;
  private interruptQueue: Promise<void> = Promise.resolve();
  private nextInterruptId = 0;
  private generation = 0;

  get phase(): RpcTurnPhase {
    return this.state.phase;
  }

  get isActive(): boolean {
    return Boolean(this.currentTurn);
  }

  get activeRequestTag(): string {
    return this.currentTurn?.requestTag || "";
  }

  get turnGeneration(): number {
    return this.generation;
  }

  get completion(): Promise<void> | null {
    return this.currentTurn?.completion || null;
  }

  async waitForIdle() {
    if (!this.currentTurn) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  openTurn(
    requestTag: string,
    onOwnedUserStart?: (message: unknown) => void,
    interrupt?: RpcTurnInterrupt,
  ): RpcTrackedTurn<TSettlement> {
    if (this.currentTurn) throw new Error("rpc_turn_already_active");
    if (
      this.state.phase === "interrupting" &&
      (!interrupt || !this.isInterruptCurrent(interrupt))
    ) {
      throw new Error("Turn interruption is in progress.");
    }
    const turn = new RpcTrackedTurn<TSettlement>(
      requestTag,
      (this.generation += 1),
    );
    turn.onOwnedUserStart = onOwnedUserStart;
    this.state =
      this.state.phase === "interrupting"
        ? { ...this.state, turn }
        : { phase: "running", turn };
    return turn;
  }

  setCompletion(
    turn: RpcTrackedTurn<TSettlement>,
    completion: Promise<void>,
  ): void {
    if (this.currentTurn !== turn) throw new Error("RPC turn owner changed.");
    turn.bindCompletion(completion);
  }

  closeTurn(turn: RpcTrackedTurn<TSettlement>): void {
    if (this.currentTurn !== turn) return;
    if (this.state.phase === "interrupting") {
      const { turn: _turn, ...interruptState } = this.state;
      this.state = interruptState;
    } else {
      this.state = { phase: "idle" };
    }
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  assertAdmissionOpen(): void {
    if (this.state.phase === "interrupting") {
      throw new Error("Turn interruption is in progress.");
    }
  }

  admit(input: {
    requestTag: string;
    observedRole: RpcInputObservedRole;
    text: string;
    hasImages: boolean;
  }): RpcTurnAdmission {
    this.assertAdmissionOpen();
    const trackedTurn = this.currentTurn;
    let resolveStarted: ((generation: number | null) => void) | undefined;
    const started = trackedTurn
      ? new Promise<number | null>((resolve) => {
          resolveStarted = resolve;
        })
      : undefined;
    let resolveCancelled: (() => void) | undefined;
    const cancelled = trackedTurn
      ? new Promise<void>((resolve) => {
          resolveCancelled = resolve;
        })
      : undefined;
    const admission: RpcTurnAdmission = {
      requestTag: input.requestTag,
      observedRole: input.observedRole,
      text: input.text.trim(),
      hasImages: input.hasImages,
      turn: trackedTurn as RpcTrackedTurn<unknown> | undefined,
      started,
      cancelled,
      resolveStarted,
      resolveCancelled,
    };
    this.pendingAdmissions.push(admission);
    trackedTurn?.admissions.push(admission);
    if (input.requestTag) {
      this.admittedByTag.set(input.requestTag, input.observedRole);
    }
    return admission;
  }

  removeAdmission(admission: RpcTurnAdmission): void {
    const index = this.pendingAdmissions.indexOf(admission);
    if (index < 0) return;
    this.pendingAdmissions.splice(index, 1);
    this.cancelAdmission(admission);
    if (admission.requestTag) this.admittedByTag.delete(admission.requestTag);
  }

  clearAdmissions(): void {
    for (const admission of this.pendingAdmissions) {
      this.cancelAdmission(admission);
    }
    this.pendingAdmissions.length = 0;
    for (const admission of this.currentTurn?.admissions || []) {
      this.cancelAdmission(admission);
    }
  }

  clearTrackedAdmissions(): void {
    this.clearAdmissions();
    this.admittedByTag.clear();
  }

  resetAdmissions(): void {
    this.clearTrackedAdmissions();
    this.recentByTag.clear();
  }

  cancelActiveTurn(reason = "Request was aborted"): void {
    this.currentTurn?.cancel(reason);
    this.clearTrackedAdmissions();
  }

  observedRole(requestTag: string): RpcInputObservedRole | undefined {
    this.assertAdmissionOpen();
    return (
      this.admittedByTag.get(requestTag) || this.recentByTag.get(requestTag)
    );
  }

  isAdmissionPending(requestTag: string): boolean {
    this.assertAdmissionOpen();
    return this.pendingAdmissions.some(
      (admission) => admission.requestTag === requestTag,
    );
  }

  observePersistedUser(requestTag: string): void {
    if (!requestTag) return;
    const observedRole = this.admittedByTag.get(requestTag);
    if (!observedRole) return;
    this.admittedByTag.delete(requestTag);
    this.rememberRecent(requestTag, observedRole);
  }

  observeUserStart(input: RpcUserStart): RpcUserStartMatch | undefined {
    const index = input.requestTag
      ? this.pendingAdmissions.findIndex(
          (admission) => admission.requestTag === input.requestTag,
        )
      : this.pendingAdmissions.findIndex(
          (admission) =>
            admission.text === input.text.trim() &&
            admission.hasImages === input.hasImages,
        );
    if (index < 0) return undefined;
    const admission = this.pendingAdmissions.splice(index, 1)[0];
    if (admission.requestTag) {
      this.admittedByTag.delete(admission.requestTag);
      this.rememberRecent(admission.requestTag, admission.observedRole);
    }
    const trackedTurn = admission.turn as
      | RpcTrackedTurn<TSettlement>
      | undefined;
    if (admission.observedRole === "nonterminal") {
      trackedTurn?.onOwnedUserStart?.(input.message);
    }
    admission.resolveStarted?.(trackedTurn?.settlementGeneration ?? null);
    admission.resolveStarted = undefined;
    return {
      requestTag: input.requestTag || admission.requestTag,
      admission,
    };
  }

  runInterrupt<T>(
    operation: (interrupt: RpcTurnInterrupt) => Promise<T>,
    options: { invalidate?: boolean } = {},
  ): Promise<T> {
    if (options.invalidate) this.interruptEpoch += 1;
    const interrupt = this.enqueueInterrupt();
    const admission = this.interruptQueue.then(() => {
      if (interrupt.epoch !== this.interruptEpoch) {
        throw new Error("Turn interruption was cancelled.");
      }
      this.activateInterrupt(interrupt);
      return operation(interrupt);
    });
    const trackedAdmission = admission.finally(() => {
      this.endInterrupt(interrupt);
    });
    this.interruptQueue = trackedAdmission.then(
      () => undefined,
      () => undefined,
    );
    return trackedAdmission;
  }

  isInterruptCurrent(interrupt: RpcTurnInterrupt): boolean {
    return (
      this.state.phase === "interrupting" &&
      this.state.active?.id === interrupt.id &&
      interrupt.epoch === this.interruptEpoch
    );
  }

  private enqueueInterrupt(): RpcTurnInterrupt {
    const interrupt = {
      id: (this.nextInterruptId += 1),
      epoch: this.interruptEpoch,
    };
    const turn = this.currentTurn;
    this.state =
      this.state.phase === "interrupting"
        ? { ...this.state, depth: this.state.depth + 1 }
        : { phase: "interrupting", depth: 1, ...(turn ? { turn } : {}) };
    return interrupt;
  }

  private activateInterrupt(interrupt: RpcTurnInterrupt): void {
    if (this.state.phase !== "interrupting") {
      throw new Error("Turn interruption is not active.");
    }
    this.state = { ...this.state, active: interrupt };
  }

  private endInterrupt(interrupt: RpcTurnInterrupt): void {
    if (this.state.phase !== "interrupting") return;
    const turn = this.state.turn;
    if (this.state.depth > 1) {
      this.state = {
        phase: "interrupting",
        depth: this.state.depth - 1,
        ...(turn ? { turn } : {}),
      };
      return;
    }
    this.state = turn ? { phase: "running", turn } : { phase: "idle" };
    void interrupt;
  }

  private get currentTurn(): RpcTrackedTurn<TSettlement> | undefined {
    return this.state.phase === "idle" ? undefined : this.state.turn;
  }

  private cancelAdmission(admission: RpcTurnAdmission): void {
    admission.resolveStarted?.(null);
    admission.resolveStarted = undefined;
    admission.resolveCancelled?.();
    admission.resolveCancelled = undefined;
  }

  private rememberRecent(
    requestTag: string,
    observedRole: RpcInputObservedRole,
  ): void {
    this.recentByTag.delete(requestTag);
    this.recentByTag.set(requestTag, observedRole);
    while (this.recentByTag.size > 1024) {
      const oldest = this.recentByTag.keys().next().value;
      if (!oldest) break;
      this.recentByTag.delete(oldest);
    }
  }
}

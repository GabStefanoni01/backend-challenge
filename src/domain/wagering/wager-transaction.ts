import { Money } from '../shared/money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export type FailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_WOULD_OVERDRAW'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_INVALID'
  | 'DUPLICATE_REVERSAL'
  | 'WALLET_NOT_FOUND'
  | 'PLAYER_MISMATCH';

export interface WagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt?: Date;
}

export interface WagerTransactionState extends WagerTransactionProps {
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

export class WagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WagerTransactionError';
  }
}

export class WagerTransaction {
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    processedAt?: Date,
  ) {
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAt = processedAt;
  }

  static create(props: WagerTransactionProps): WagerTransaction {
    if (!props.id || !props.providerId || !props.externalTransactionId || !props.idempotencyKey) {
      throw new WagerTransactionError('Transaction identity fields are required');
    }
    if (!/^[a-f0-9]{64}$/i.test(props.payloadHash)) {
      throw new WagerTransactionError('payloadHash must be a SHA-256 hex digest');
    }
    if (!props.money.isPositive()) throw new WagerTransactionError('Transaction amount must be positive');
    if (props.kind === WagerTransactionKind.Opening) {
      throw new WagerTransactionError('OPENING transactions are internal only');
    }
    if (
      (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new WagerTransactionError('REFUND and ROLLBACK require a reference transaction');
    }

    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId,
      props.kind, props.money, props.referenceExternalTransactionId,
      props.createdAt ?? new Date(), WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey,
      state.payloadHash, state.walletId, state.playerId, state.roundId, state.gameId,
      state.kind, state.money, state.referenceExternalTransactionId, state.createdAt,
      state.status, state.referenceTransactionId, state.failureCode, state.processedAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  markPendingReference(): void {
    this.assertCanTransition();
    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(referenceTransactionId?: string, at: Date = new Date()): void {
    this.assertCanTransition();
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._status = WagerTransactionStatus.Processed;
  }

  reject(code: FailureCode): void {
    this.assertCanTransition();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertCanTransition();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): 'DEBIT' | 'CREDIT' | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return 'DEBIT';
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return 'CREDIT';
      case WagerTransactionKind.Rollback:
        if (!reference) throw new WagerTransactionError('ROLLBACK direction requires its reference');
        return reference.ledgerDirectionFor() === 'DEBIT' ? 'CREDIT' : 'DEBIT';
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Opening:
        return undefined;
    }
  }

  private assertCanTransition(): void {
    if (this.isTerminal()) {
      throw new WagerTransactionError(`Cannot transition terminal transaction in state ${this._status}`);
    }
  }
}

export type JsonLikePiOptionBag = Record<string, unknown>;

export type RinPiPassthroughOptions = {
  /**
   * Pi-owned parsed/startup values that must survive Rin process boundaries.
   * Consumers should prefer Pi public helpers when turning this bag into
   * concrete SDK options.
   */
  piStartupOptions?: JsonLikePiOptionBag;
  /** Same-process Pi service factory options. May contain non-JSON values. */
  piAgentSessionServicesOptions?: Record<string, unknown>;
  /** Same-process Pi session creation options. May contain non-JSON values. */
  piAgentSessionOptions?: Record<string, unknown>;
};

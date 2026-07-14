export interface ServerService {
  readonly start: () => Promise<void>;
}

export const foundationService: ServerService = {
  async start(): Promise<void> {
    throw new Error("The server runtime is not implemented in this foundation build.");
  },
};

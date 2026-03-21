import type { PermissionRequest } from "./types.js";

/**
 * Encapsulates pending permission state with a typed Promise API.
 */
export class PermissionGate {
  private request?: PermissionRequest;
  private resolveFn?: (optionId: string) => void;
  private rejectFn?: (reason: Error) => void;
  private settled = false;

  setPending(request: PermissionRequest): Promise<string> {
    this.request = request;
    this.settled = false;

    return new Promise<string>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolve(optionId: string): void {
    if (this.settled || !this.resolveFn) return;
    this.settled = true;
    this.resolveFn(optionId);
    this.cleanup();
  }

  reject(reason?: string): void {
    if (this.settled || !this.rejectFn) return;
    this.settled = true;
    this.rejectFn(new Error(reason ?? "Permission rejected"));
    this.cleanup();
  }

  get isPending(): boolean {
    return !!this.request && !this.settled;
  }

  get currentRequest(): PermissionRequest | undefined {
    return this.isPending ? this.request : undefined;
  }

  /** The request ID of the current pending request, undefined after settlement */
  get requestId(): string | undefined {
    return this.request?.id;
  }

  private cleanup(): void {
    this.request = undefined;
    this.resolveFn = undefined;
    this.rejectFn = undefined;
  }
}

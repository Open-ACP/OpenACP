export interface TunnelProvider {
  start(localPort: number): Promise<string>  // returns public URL
  stop(): Promise<void>
  getPublicUrl(): string
}

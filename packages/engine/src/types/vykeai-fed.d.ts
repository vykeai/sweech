declare module '@vykeai/fed' {
  export class FedEventClient {
    constructor(baseUrl: string, identity?: string);
    publish(type: string, source: string, data: unknown): Promise<unknown>;
  }

  export interface ToolRegistration {
    name: string;
    displayName: string;
    port: number;
    fedPort: number;
    identity: string;
    version: string;
    capabilities?: string[];
    getInfo?: () => Promise<Record<string, unknown>>;
    getRuns?: () => Promise<unknown[]>;
    getWidget?: () => Promise<unknown>;
  }

  export function registerTool(reg: ToolRegistration): Promise<() => void>;
}

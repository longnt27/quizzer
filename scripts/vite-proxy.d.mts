interface ProxyServer {
  on(event: string, listener: (proxyRequest: { setHeader(name: string, value: string): void }) => void): unknown;
}

export declare const configureServiceProxy: (proxy: ProxyServer, serviceToken?: string) => ProxyServer;

export class Netcode {
  public mode: 'offline' | 'host' | 'client' = 'offline';
  public state: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

  public async connect() {
    this.state = 'connecting';
    await Promise.resolve();
    this.state = 'connected';
    return this.mode;
  }

  public setMode(mode: 'offline' | 'host' | 'client') {
    this.mode = mode;
  }

  public disconnect() {
    this.state = 'disconnected';
  }
}

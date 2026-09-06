import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RpcFrame } from '../../src/providers/codex/rpc';

export class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: RpcFrame[] = [];
  constructor(readonly respond: (frame: RpcFrame, process: FakeProcess) => void = () => {}) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)) as RpcFrame;
        buffer = buffer.slice(newline + 1); this.frames.push(frame); this.respond(frame, this);
      }
    });
  }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
  send(frame: RpcFrame): void { this.stdout.write(`${JSON.stringify(frame)}\n`); }
  reply(frame: RpcFrame, result: unknown): void { this.send({ id: frame.id, result }); }
  reject(frame: RpcFrame, code = -1): void { this.send({ id: frame.id, error: { code, message: 'Fixture rejection' } }); }
}

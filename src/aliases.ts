/**
 * Alias management for sweetch commands
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from './atomicWrite';

export type AliasMap = Record<string, string>;

export class AliasManager {
  private aliasFile: string;

  constructor() {
    const configDir = path.join(os.homedir(), '.sweech');
    this.aliasFile = path.join(configDir, 'aliases.json');
  }

  public getAliases(): AliasMap {
    if (!fs.existsSync(this.aliasFile)) {
      return {};
    }

    try {
      const data = fs.readFileSync(this.aliasFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  public addAlias(alias: string, command: string): void {
    const aliases = this.getAliases();

    if (aliases[alias]) {
      throw new Error(`Alias '${alias}' already exists (points to '${aliases[alias]}')`);
    }

    aliases[alias] = command;
    atomicWriteFileSync(this.aliasFile, JSON.stringify(aliases, null, 2));
  }

  public removeAlias(alias: string): void {
    const aliases = this.getAliases();

    if (!aliases[alias]) {
      throw new Error(`Alias '${alias}' does not exist`);
    }

    delete aliases[alias];
    atomicWriteFileSync(this.aliasFile, JSON.stringify(aliases, null, 2));
  }

  public resolveAlias(commandOrAlias: string): string {
    const aliases = this.getAliases();
    return aliases[commandOrAlias] || commandOrAlias;
  }

  public isAlias(name: string): boolean {
    const aliases = this.getAliases();
    return name in aliases;
  }
}

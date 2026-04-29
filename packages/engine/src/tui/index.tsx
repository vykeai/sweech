import React from 'react';
import { render } from 'ink';
import { ConfigApp } from './ConfigApp.js';

export function runConfigTUI(): void {
  render(React.createElement(ConfigApp));
}

#!/usr/bin/env node
// JavaScript entrypoint for the compiled CLI implementation.
export * from '../dist/cli.js';
import * as implementation from '../dist/cli.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) { implementation.main().then(code=>{process.exitCode=code;},error => {console.error(error.message);process.exitCode=1;}); }

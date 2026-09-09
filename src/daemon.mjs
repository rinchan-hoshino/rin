// JavaScript entrypoint for the compiled daemon implementation.
export * from '../dist/daemon.js';
import * as implementation from '../dist/daemon.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) { implementation.main().catch(error=>{console.error(error.message);process.exitCode=1;}); }

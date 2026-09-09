// JavaScript entrypoint for the compiled Rin implementation.
export * from '../dist/rin.js';
import * as implementation from '../dist/rin.js';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) { implementation.main().catch(error=>{console.error(error.message);process.exitCode=1;}); }

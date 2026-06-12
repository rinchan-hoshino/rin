#!/usr/bin/env node
import { runFrontendEntrypoint } from "../rin-frontend-sdk/entrypoint.js";

import { startTui } from "./launcher.js";

runFrontendEntrypoint(startTui);

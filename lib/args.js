'use strict';

/**
 * Minimal CLI argument parser. No external dependencies.
 *
 * Parses:
 *   --host/-H HOST
 *   --port/-p PORT
 *   --password/-P PASS
 *   --session/-s ID
 *   --json
 *   --help/-h
 *   --version/-v
 *   --timeout MS
 *
 * First non-option argument is `command`; the rest are `commandArgs`.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ options: object, command: string|null, commandArgs: string[] }}
 */
function parseArgs(argv) {
  const options = {
    host:     'localhost',
    port:     5900,
    password: null,
    session:  null,
    json:     false,
    help:     false,
    version:  false,
    timeout:  10000,
  };

  let command = null;
  const commandArgs = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--host' || arg === '-H') {
      options.host = argv[++i];
    } else if (arg === '--port' || arg === '-p') {
      options.port = parseInt(argv[++i], 10);
    } else if (arg === '--password' || arg === '-P') {
      options.password = argv[++i];
    } else if (arg === '--session' || arg === '-s') {
      options.session = argv[++i];
    } else if (arg === '--timeout') {
      options.timeout = parseInt(argv[++i], 10);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg.startsWith('--')) {
      // Unknown long option: consume optional value if next arg is not a flag
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++;
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Unknown short option: skip
    } else {
      // Positional
      if (command === null) {
        command = arg;
      } else {
        commandArgs.push(arg);
      }
    }

    i++;
  }

  return { options, command, commandArgs };
}

module.exports = { parseArgs };

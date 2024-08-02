import { execa } from "execa";
import fs from "fs-extra";
import path from "path";
import { isHash } from "viem";

import { getAbsolutePath } from "../helper.mjs";

export default function Run(verbose, blockTime, epoch_length, listen_port) {
  function getMachineHash() {
    // read hash of the cartesi machine snapshot, if one exists
    const hashPath = getAbsolutePath("image", "hash");
    if (fs.existsSync(hashPath)) {
      const hash = fs.readFileSync(hashPath).toString("hex");
      if (isHash(`0x${hash}`)) {
        return `0x${hash}`;
      }
    }
    return undefined;
  }

  async function run() {
    let projectName;

    // get machine hash
    const hash = getMachineHash();

    // Check if snapshot exists
    if (!hash) {
      throw new Error(
        `Cartesi machine snapshot not found, run '${this.config.bin} build'`
      );
    }
    projectName = hash.substring(2, 10);

    // path of the tool instalation
    const pathArr = path.dirname(new URL(import.meta.url).pathname).split("/");
    const binPath = path.join(path.join(...pathArr), "..");

    // setup the environment variable used in docker compose
    const blockInterval = blockTime || 5;
    const epochLength = epoch_length || 720;
    const listenPort = listen_port || 8080;
    const env = {
      ANVIL_VERBOSITY: verbose ? "--steps-tracing" : "--silent",
      BLOCK_TIME: blockInterval.toString(),
      BLOCK_TIMEOUT: (blockInterval + 3).toString(),
      CARTESI_EPOCH_LENGTH: epochLength.toString(),
      CARTESI_EXPERIMENTAL_DISABLE_CONFIG_LOG: verbose ? "false" : "true",
      CARTESI_EXPERIMENTAL_SERVER_MANAGER_BYPASS_LOG: verbose
        ? "false"
        : "true",
      CARTESI_LOG_LEVEL: verbose ? "info" : "error",
      CARTESI_SNAPSHOT_DIR: "/usr/share/rollups-node/snapshot",
      CARTESI_BIN_PATH: binPath,
      CARTESI_LISTEN_PORT: listenPort.toString(),
    };

    // validator
    const composeFiles = ["docker-compose-validator.yaml"];

    // prompt
    composeFiles.push("docker-compose-prompt.yaml");

    // database
    composeFiles.push("docker-compose-database.yaml");

    // proxy
    composeFiles.push("docker-compose-proxy.yaml");

    // anvil
    composeFiles.push("docker-compose-anvil.yaml");

    // explorer
    composeFiles.push("docker-compose-explorer.yaml");

    // snapshot volume
    composeFiles.push("docker-compose-snapshot-volume.yaml");

    // add project env file loading
    if (fs.existsSync("./.cartesi.env")) {
      composeFiles.push("docker-compose-envfile.yaml");
    }

    // create the "--file <file>" list
    const files = composeFiles
      .map((f) => ["--file", path.normalize(path.join(binPath, "node", f))])
      .flat();

    const compose_args = [
      "compose",
      ...files,
      "--project-directory",
      ".",
      "--project-name",
      projectName,
    ];

    const up_args = [];

    if (!verbose) {
      compose_args.push("--progress", "quiet");
      up_args.push("--attach", "validator");
      up_args.push("--attach", "prompt");
    }

    // XXX: need this handler, so SIGINT can still call the finally block below
    process.on("SIGINT", () => {});

    try {
      // run compose environment
      await execa("docker", [...compose_args, "up", ...up_args], {
        env,
        stdio: "inherit",
      });
    } catch (e) {
      // 130 is a graceful shutdown, so we can swallow it
      if (e.exitCode !== 130) {
        throw e;
      }
    } finally {
      // shut it down, including volumes
      await execa("docker", [...compose_args, "down", "--volumes"], {
        env,
        stdio: "inherit",
      });
    }
  }
  run();
}

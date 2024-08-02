import bytes from "bytes";
import { execa } from "execa";
import fs from "fs-extra";
import semver from "semver";
import tmp from "tmp";

import { getAbsolutePath } from "../helper.mjs";

const CARTESI_LABEL_PREFIX = "io.cartesi.rollups";
const CARTESI_LABEL_RAM_SIZE = `${CARTESI_LABEL_PREFIX}.ram_size`;
const CARTESI_LABEL_DATA_SIZE = `${CARTESI_LABEL_PREFIX}.data_size`;
const CARTESI_DEFAULT_RAM_SIZE = "128Mi";

const CARTESI_LABEL_SDK_VERSION = `${CARTESI_LABEL_PREFIX}.sdk_version`;
const CARTESI_LABEL_SDK_NAME = `${CARTESI_LABEL_PREFIX}.sdk_name`;
const CARTESI_DEFAULT_SDK_VERSION = "0.9.0";

export default function build(imageHash) {
  async function getImageInfo(image) {
    const { stdout: jsonStr } = await execa("docker", [
      "image",
      "inspect",
      image,
    ]);
    // parse image info from docker inspect output
    const [imageInfo] = JSON.parse(jsonStr);

    // validate image architecture (must be riscv64)
    if (imageInfo["Architecture"] !== "riscv64") {
      throw new Error(
        `Invalid image Architecture: ${imageInfo["Architecture"]}. Expected riscv64`
      );
    }

    const labels = imageInfo["Config"]["Labels"] || {};
    const info = {
      cmd: imageInfo["Config"]["Cmd"] ?? [],
      dataSize: labels[CARTESI_LABEL_DATA_SIZE] ?? "10Mb",
      entrypoint: imageInfo["Config"]["Entrypoint"] ?? [],
      env: imageInfo["Config"]["Env"] || [],
      ramSize: labels[CARTESI_LABEL_RAM_SIZE] ?? CARTESI_DEFAULT_RAM_SIZE,
      sdkName: labels[CARTESI_LABEL_SDK_NAME] ?? "cartesi/sdk",
      sdkVersion:
        labels[CARTESI_LABEL_SDK_VERSION] ?? CARTESI_DEFAULT_SDK_VERSION,
      workdir: imageInfo["Config"]["WorkingDir"],
    };

    if (!info.entrypoint && !info.cmd) {
      throw new Error("Undefined image ENTRYPOINT or CMD");
    }

    // fail if using unsupported sdk version
    if (!semver.valid(info.sdkVersion)) {
      this.warn("sdk version is not a valid semver");
    } else if (
      info.sdkName == "cartesi/sdk" &&
      semver.lt(info.sdkVersion, CARTESI_DEFAULT_SDK_VERSION)
    ) {
      throw new Error(
        `Unsupported sdk version: ${info.sdkVersion} (used) < ${CARTESI_DEFAULT_SDK_VERSION} (minimum).`
      );
    }

    // warn for using default values
    info.sdkVersion ||
      this.warn(
        `Undefined ${CARTESI_LABEL_SDK_VERSION} label, defaulting to ${CARTESI_DEFAULT_SDK_VERSION}`
      );

    info.ramSize ||
      this.warn(
        `Undefined ${CARTESI_LABEL_RAM_SIZE} label, defaulting to ${CARTESI_DEFAULT_RAM_SIZE}`
      );

    // validate data size value
    if (bytes(info.dataSize) === null) {
      throw new Error(
        `Invalid ${CARTESI_LABEL_DATA_SIZE} value: ${info.dataSize}`
      );
    }

    // XXX: validate other values

    return info;
  }

  // saves the OCI Image to a tarball
  async function createTarball(image, outputFilePath) {
    // create docker tarball from app image
    await execa("docker", ["image", "save", image, "-o", outputFilePath]);
  }

  // this wraps the call to the sdk image with a one-shot approach
  // the (inputPath, outputPath) signature will mount the input as a volume and copy the output with docker cp
  async function sdkRun(sdkImage, cmd, inputPath, outputPath) {
    const { stdout: cid } = await execa("docker", [
      "container",
      "create",
      "--volume",
      `${inputPath}:/tmp/input`,
      sdkImage,
      ...cmd,
    ]);

    await execa("docker", ["container", "start", "-a", cid], {
      stdio: "inherit",
    });

    await execa("docker", [
      "container",
      "cp",
      `${cid}:/tmp/output`,
      outputPath,
    ]);

    await execa("docker", ["container", "stop", cid]);
    await execa("docker", ["container", "rm", cid]);
  }

  // returns the command to create rootfs tarball from an OCI Image tarball
  function createRootfsTarCommand() {
    const cmd = [
      "cat",
      "/tmp/input",
      "|",
      "crane",
      "export",
      "-", // OCI Image from stdin
      "-", // rootfs tarball to stdout
      "|",
      "bsdtar",
      "-cf",
      "/tmp/output",
      "--format=gnutar",
      "@/dev/stdin", // rootfs tarball from stdin
    ];
    return ["/usr/bin/env", "bash", "-c", cmd.join(" ")];
  }

  // returns the command to create ext2 from a rootfs
  function createExt2Command(extraBytes) {
    const blockSize = 4096;
    const extraBlocks = Math.ceil(extraBytes / blockSize);
    const extraSize = `+${extraBlocks}`;

    return [
      "xgenext2fs",
      "--tarball",
      "/tmp/input",
      "--block-size",
      blockSize.toString(),
      "--faketime",
      "-r",
      extraSize,
      "/tmp/output",
    ];
  }

  function createMachineSnapshotCommand(info) {
    const ramSize = info.ramSize;
    const driveLabel = "root"; // XXX: does this need to be customizable?

    // list of environment variables of docker image
    const envs = info.env.map((variable) => `--env=${variable}`);

    // ENTRYPOINT and CMD as a space separated string
    const entrypoint = [...info.entrypoint, ...info.cmd].join(" ");

    // command to change working directory if WORKDIR is defined
    const cwd = info.workdir ? `--workdir=${info.workdir}` : "";
    return [
      "create_machine_snapshot",
      `--ram-length=${ramSize}`,
      `--drive-label=${driveLabel}`,
      `--drive-filename=/tmp/input`,
      `--output=/tmp/output`,
      cwd,
      ...envs,
      `--entrypoint=${entrypoint}`,
    ];
  }

  async function run() {
    const snapshotPath = getAbsolutePath("image");
    const tarPath = getAbsolutePath("image.tar");
    const gnuTarPath = getAbsolutePath("image.gnutar");
    const ext2Path = getAbsolutePath("image.ext2");

    // clean up temp files we create along the process
    tmp.setGracefulCleanup();

    // use pre-existing image or build dapp image
    const appImage = imageHash;

    // prepare context directory
    await fs.emptyDir(getAbsolutePath()); // XXX: make it less error prone

    // get and validate image info
    const imageInfo = await getImageInfo(appImage);

    // resolve sdk version
    const sdkImage = `${imageInfo.sdkName}:${imageInfo.sdkVersion}`;

    try {
      // create docker tarball for image specified
      await createTarball(appImage, tarPath);

      // create rootfs tar
      await sdkRun(sdkImage, createRootfsTarCommand(), tarPath, gnuTarPath);

      // create ext2
      await sdkRun(
        sdkImage,
        createExt2Command(bytes.parse(imageInfo.dataSize)),
        gnuTarPath,
        ext2Path
      );

      // create machine snapshot
      await sdkRun(
        sdkImage,
        createMachineSnapshotCommand(imageInfo),
        ext2Path,
        snapshotPath
      );
      await fs.chmod(snapshotPath, 0o755);
    } finally {
      await fs.remove(gnuTarPath);
      await fs.remove(tarPath);
    }
  }
  run();
}

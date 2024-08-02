import build from "./commands/build.mjs";
import Run from "./commands/run.mjs";

// Get the command-line arguments
const args = process.argv.slice(2);

if (args[0] === "build") {
  if (args.length !== 2) {
    console.log("Usage: npm run build <image-hash>");
    process.exit(1);
  }

  const imageHash = args[1];
  build(imageHash);
}

// verbose, blockTime, epoch_length, listen_port
if (args[0] === "run") {
  let [_, first, second, third, fourth] = args;

  if (first === "help") {
    console.log(
      "Usage: npm run <verbose> <block time in seconds default 5> <epoch_lenght default 720> <listening port default 8080>"
    );
    process.exit(1);
  }

  Run(
    Boolean(first) || undefined,
    Number(second) || undefined,
    Number(third) || undefined,
    fourth || undefined
  );
}

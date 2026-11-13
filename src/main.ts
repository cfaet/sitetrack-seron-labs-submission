import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

const main = Effect.log("SiteTrack scaffold ready")

NodeRuntime.runMain(main)

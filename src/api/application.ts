import { HttpRouter } from "effect/http"
import { Layer } from "effect"
import { HttpApiBuilder, HttpApiSwagger } from "effect/http-api"
import { AuthSettings } from "../config/auth.js"
import { Database } from "../repositories/database.js"
import { Auth } from "../services/auth.js"
import { Projects } from "../services/projects.js"
import { Teams } from "../services/teams.js"
import { Tasks } from "../services/tasks.js"
import { Passwords, Tokens, Throttle } from "../services/security.js"
import { Api } from "./api.js"
import { featureHandlers, browserMiddleware } from "./features.js"
import { HealthHandlers, NotFound, RequestMiddleware, databaseHealthLayer } from "./routes.js"
export const services = Layer.mergeAll(Projects.layer, Teams.layer, Tasks.layer).pipe(
  Layer.provideMerge(Auth.layer),
  Layer.provideMerge(Layer.mergeAll(Passwords.layer, Tokens.layer, Throttle.layer)),
  Layer.provideMerge(Database.layer)
)
export const applicationRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Layer.mergeAll(HealthHandlers, featureHandlers))
  ),
  HttpApiSwagger.layer(Api, { path: "/docs" }),
  NotFound
).pipe(
  Layer.provide(browserMiddleware.layer),
  Layer.provide(RequestMiddleware.layer),
  HttpRouter.provideRequest(Layer.mergeAll(services, Layer.effect(AuthSettings, AuthSettings))),
  Layer.provide(Layer.mergeAll(services, databaseHealthLayer))
)

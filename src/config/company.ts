import { Context, DateTime, Effect, Layer, Option } from "effect"
import { ConfigurationError } from "./config.js"

export const defaultCompanyZone = DateTime.zoneMakeNamedUnsafe("Asia/Muscat")
export class CompanyZone extends Context.Service<CompanyZone, DateTime.TimeZone.Named>()("sitetrack/CompanyZone") {}
export const readCompanyZone = Effect.fn("readCompanyZone")(function* (
  env: Readonly<Record<string, string | undefined>>
) {
  const name = env.COMPANY_TIME_ZONE ?? "Asia/Muscat"
  const zone = /^[+-]/.test(name) ? Option.none() : DateTime.zoneMakeNamed(name)
  if (Option.isNone(zone))
    return yield* new ConfigurationError({ message: "COMPANY_TIME_ZONE must be a valid named timezone." })
  return zone.value
})
export const companyInstant = (instant: DateTime.DateTime, zone: DateTime.TimeZone.Named) => ({
  today: DateTime.formatIsoDate(DateTime.setZone(instant, zone)),
  instant: DateTime.formatIso(instant)
})
export class CompanyTime extends Context.Service<
  CompanyTime,
  { readonly now: Effect.Effect<{ readonly today: string; readonly instant: string }> }
>()("sitetrack/CompanyTime") {
  static readonly layer = Layer.effect(
    CompanyTime,
    Effect.map(CompanyZone, (zone) => ({ now: Effect.map(DateTime.now, (instant) => companyInstant(instant, zone)) }))
  )
}

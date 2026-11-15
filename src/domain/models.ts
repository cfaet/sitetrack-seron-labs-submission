import { Schema } from "effect"

export const Role = Schema.Literals(["User", "CompanyStoreManager", "SuperAdmin"])
export const Uuid = Schema.String.check(Schema.isUUID())
export const Name = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(120))
export const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/), Schema.isMaxLength(254))
export const Password = Schema.String.check(Schema.isMinCodePoints(15), Schema.isMaxCodePoints(128))
export const Register = Schema.Struct({ name: Name, email: Email, password: Password, role: Role })
export const Login = Schema.Struct({ email: Email, password: Password })
export const User = Schema.Struct({ id: Uuid, name: Schema.String, email: Schema.String, role: Role, createdAt: Schema.String })
export type User = typeof User.Type
export const Actor = Schema.Struct({ user: User, sessionId: Uuid })
export type Actor = typeof Actor.Type
export const SessionResult = Schema.Struct({ user: User, accessToken: Schema.String, tokenType: Schema.Literal("Bearer"), accessTokenExpiresAt: Schema.String, refreshExpiresAt: Schema.String, sessionExpiresAt: Schema.String })
export const isCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10))
  const lengths = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (lengths[month - 1] ?? 0)
}
export const CalendarDate = Schema.String.check(Schema.makeFilter(isCalendarDate, { expected: "Gregorian YYYY-MM-DD date" }))
export const ProjectName = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200))
export const ProjectInput = Schema.Struct({ name: ProjectName, startDate: CalendarDate, endDate: CalendarDate }).check(
  Schema.makeFilter((input) => input.startDate <= input.endDate, { expected: "startDate on or before endDate" })
)
export const ProjectPatch = Schema.Struct({ name: Schema.optionalKey(ProjectName), startDate: Schema.optionalKey(CalendarDate), endDate: Schema.optionalKey(CalendarDate) }).check(
  Schema.makeFilter((input) => Object.keys(input).length > 0, { expected: "at least one editable field" })
)
export const ProjectId = Schema.String.check(Schema.isPattern(/^PRJ-\d{4,}$/))
export const Project = Schema.Struct({ id: ProjectId, name: Schema.String, startDate: CalendarDate, endDate: CalendarDate, isAdmin: Schema.Boolean, memberCount: Schema.Int })
export type Project = typeof Project.Type
export const PageNumber = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000000 }))
export const PageSize = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))
export const ListQuery = Schema.Struct({ page: Schema.optionalKey(PageNumber), pageSize: Schema.optionalKey(PageSize) })
export type ListQuery = typeof ListQuery.Type
export const ProjectQuery = Schema.Struct({ ...ListQuery.fields, search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))), sort: Schema.optionalKey(Schema.Literals(["name", "startDate"])), direction: Schema.optionalKey(Schema.Literals(["asc", "desc"])) })
export const Pagination = Schema.Struct({ page: Schema.Int, pageSize: Schema.Int, total: Schema.Int, totalPages: Schema.Int })
export const collection = <S extends Schema.Constraint>(item: S) => Schema.Struct({ items: Schema.Array(item), pagination: Pagination })
export const Member = Schema.Struct({ ...User.fields, isAdmin: Schema.Boolean })
export const InvitationStatus = Schema.Literals(["Pending", "Accepted", "Rejected", "Withdrawn"])
export const Invitation = Schema.Struct({ id: Uuid, projectId: ProjectId, invitee: User, inviterId: Uuid, status: InvitationStatus, createdAt: Schema.String })
export const Notification = Schema.Struct({ id: Uuid, project: Schema.Struct({ id: ProjectId, name: Schema.String }), invitation: Schema.Struct({ id: Uuid, status: InvitationStatus }), createdAt: Schema.String, readAt: Schema.NullOr(Schema.String), allowedActions: Schema.Array(Schema.Literals(["accept", "reject"])) })
export const InviteInput = Schema.Struct({ email: Email })
export const MemberPatch = Schema.Struct({ isAdmin: Schema.Boolean })
export const Empty = Schema.Struct({})
export const publicProjectId = (number: string) => `PRJ-${number.padStart(4, "0")}`

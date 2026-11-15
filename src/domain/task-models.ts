import { Schema } from "effect"
import { CalendarDate, ListQuery, ProjectId, ProjectInput, ProjectPatch } from "./models.js"

export const TaskId = Schema.String.check(Schema.isPattern(/^PRJ-\d{4,}-T-\d{4,}$/))
export const TaskStatus = Schema.Literals(["NotStarted", "InProgress", "Done"])
export const TaskAction = Schema.Literals(["start", "complete", "reopen"])
export type TaskAction = typeof TaskAction.Type
export const TaskInput = ProjectInput
export const TaskPatch = ProjectPatch
export const TaskNode = Schema.Struct({
  id: TaskId,
  internalId: Schema.String.check(Schema.isUUID()),
  number: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  name: Schema.String,
  startDate: CalendarDate,
  endDate: CalendarDate,
  status: TaskStatus,
  firstStartedAt: Schema.NullOr(Schema.String)
})
export type TaskNode = typeof TaskNode.Type
export const TaskEdge = Schema.Struct({ dependent: TaskId, prerequisite: TaskId })
export type TaskEdge = typeof TaskEdge.Type
export const TaskReference = Schema.Struct({ id: TaskId, name: Schema.String, status: TaskStatus })
export const Task = Schema.Struct({
  id: TaskId,
  projectId: ProjectId,
  name: Schema.String,
  startDate: CalendarDate,
  endDate: CalendarDate,
  status: TaskStatus,
  firstStartedAt: Schema.NullOr(Schema.String),
  late: Schema.Boolean,
  blocked: Schema.Boolean,
  directPrerequisites: Schema.Array(TaskReference),
  directDependentCount: Schema.Int
})
export type Task = typeof Task.Type
export const TaskDetail = Schema.Struct({ ...Task.fields, allowedActions: Schema.Array(TaskAction) })
export const TaskRelation = Schema.Struct({ ...Task.fields, distance: Schema.Int })
export const DependencyInput = Schema.Struct({ prerequisiteTaskId: TaskId })
export const Dependency = Schema.Struct({ dependentTaskId: TaskId, prerequisiteTaskId: TaskId })
export const BooleanQuery = Schema.Literals(["true", "false"])
export const TaskQuery = Schema.Struct({
  ...ListQuery.fields,
  search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  status: Schema.optionalKey(TaskStatus),
  late: Schema.optionalKey(BooleanQuery),
  blocked: Schema.optionalKey(BooleanQuery),
  fromDate: Schema.optionalKey(CalendarDate),
  toDate: Schema.optionalKey(CalendarDate),
  sort: Schema.optionalKey(Schema.Literals(["id", "name", "startDate", "endDate", "dependentCount"])),
  direction: Schema.optionalKey(Schema.Literals(["asc", "desc"]))
}).check(
  Schema.makeFilter(
    (input) => input.fromDate === undefined || input.toDate === undefined || input.fromDate <= input.toDate,
    { expected: "fromDate on or before toDate" }
  )
)
export type TaskQuery = typeof TaskQuery.Type
export const publicTaskId = (projectId: string, number: string) => `${projectId}-T-${number.padStart(4, "0")}`

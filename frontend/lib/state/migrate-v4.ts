import type { IDBPTransaction, StoreNames } from "idb";
import type { RoleplayDB } from "../db";
import type { GoalValue, Story, StateResult } from "./types";

type LegacyGoal = Omit<GoalValue, "progressSummary"> & {
  clues: string[];
  milestones: {
    description: string;
    status: "discovered" | "in_progress" | "completed" | "discarded";
  }[];
  blockers: string[];
};
const milestoneLabels = {
  discovered: "已发现",
  in_progress: "进行中",
  completed: "已完成",
  discarded: "已排除",
};

function goal(value: LegacyGoal): GoalValue {
  return {
    description: value.description,
    status: value.status,
    currentFocus: value.currentFocus,
    progressSummary: [
      ...value.clues,
      ...value.milestones.map(
        (m) => `${m.description}（${milestoneLabels[m.status]}）`,
      ),
      ...value.blockers.map((text) => `尚待解决：${text}`),
    ].join("；"),
  };
}

function story(value: Omit<Story, "characterState" | "userState">): Story {
  return { ...value, characterState: "", userState: "" };
}

/** 仅在 v3 升级时执行；保留原记录、版本与来源，转换冻结的请求和已计算结果。 */
export async function migrateV4(
  tx: IDBPTransaction<RoleplayDB, StoreNames<RoleplayDB>[], "versionchange">,
) {
  const sessions = tx.objectStore("sessions");
  for (const session of await sessions.getAll())
    await sessions.put({ ...session, story: story(session.story) });

  const goals = tx.objectStore("goals");
  for (const entry of await goals.getAll())
    await goals.put({
      ...entry,
      value: goal(entry.value as unknown as LegacyGoal),
    });

  const tasks = tx.objectStore("stateTasks");
  for (const task of await tasks.getAll()) {
    const state = task.context.state;
    await tasks.put({
      ...task,
      context: {
        ...task.context,
        state: {
          ...state,
          story: story(state.story),
          goals: state.goals.map((entry) => ({
            ...entry,
            value: goal(entry.value as unknown as LegacyGoal),
          })),
        },
      },
    });
  }

  const operations = tx.objectStore("operations");
  for (const operation of await operations.getAll()) {
    if (operation.kind !== "state_update" || !operation.result) continue;
    const result = operation.result as StateResult;
    await operations.put({
      ...operation,
      result: {
        ...result,
        goalChanges: result.goalChanges.map((change) => ({
          ...change,
          before:
            change.before === null
              ? null
              : goal(change.before as unknown as LegacyGoal),
          value: goal(change.value as unknown as LegacyGoal),
        })),
      },
    });
  }
}

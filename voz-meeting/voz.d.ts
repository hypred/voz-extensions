export type App = { bundleID?: string; name?: string };

export type Paths = { data: string };

export type Schema =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "number" | "integer" | "boolean"; description?: string }
  | { type: "array"; description?: string; items: Schema }
  | {
      type: "object";
      description?: string;
      properties: Record<string, Schema>;
      required?: readonly string[];
    };

export type Generated<S extends Schema> = S extends { type: "string"; enum: readonly (infer Choice)[] }
  ? Choice
  : S extends { type: "string" }
    ? string
    : S extends { type: "number" | "integer" }
      ? number
      : S extends { type: "boolean" }
        ? boolean
        : S extends { type: "array"; items: infer Item extends Schema }
          ? Generated<Item>[]
          : S extends { type: "object"; properties: infer Properties extends Record<string, Schema> }
            ? { [Key in keyof Properties as Key extends RequiredKeys<S> ? Key : never]: Generated<Properties[Key]> } & {
                [Key in keyof Properties as Key extends RequiredKeys<S> ? never : Key]?: Generated<Properties[Key]>;
              }
            : never;

type RequiredKeys<S> = S extends { required: readonly (infer Key)[] } ? Key : never;

export type GenerateRequest<S extends Schema> = {
  prompt: string;
  instructions?: string;
  schema: S;
};

export type Context = {
  app: App;
  insert(text: string): void;
  press(key: string): void;
  notify(text: string): void;
  generate<const S extends Schema>(request: GenerateRequest<S>): Promise<Generated<S>>;
};

export type CommandOptions = { at?: "start" | "end" };

export type BeforeCleanupEvent = { prompt: string };
export type BeforeCleanupResult = { prompt: string } | void;
export type BeforeInsertEvent = { text: string; raw: string };
export type BeforeInsertResult = { text: string } | void;
export type CommandEvent = { text: string };
export type RecordingEvent = { path: string; seconds: number };
export type AfterInsertEvent = { text: string; raw: string };
export type TranscribeEvent = { path: string; seconds: number };
export type CleanEvent = { text: string; prompt: string };
export type CleanupStepEvent = { text: string };

export type SpeechModel = {
  id: string;
  name: string;
  transcribe(
    event: TranscribeEvent,
    ctx: Context,
  ): Awaitable<{ text: string }>;
};

export type CleanupModel = {
  id: string;
  name: string;
  clean(event: CleanEvent, ctx: Context): Awaitable<{ text: string }>;
};

export type CleanupStep = {
  id: string;
  name: string;
  run(event: CleanupStepEvent, ctx: Context): Awaitable<{ text: string } | void>;
};

export type Action = {
  id: string;
  name: string;
  hotkey?: string;
  run(ctx: Context): Awaitable<void>;
};

export type Activity = {
  title: string;
  since?: number;
  stop?: string;
};

export type Transcript = { text: string; seconds?: number };

type SettingBase = { title: string; description?: string };

export type Setting =
  | (SettingBase & { type: "string"; default: string; options?: string[]; secret?: boolean; required?: boolean })
  | (SettingBase & { type: "number"; default: number })
  | (SettingBase & { type: "boolean"; default: boolean });

export type SettingsSchema = Record<string, Setting>;

export type SettingsValues<Schema extends SettingsSchema> = {
  [Key in keyof Schema]: Schema[Key]["default"];
};

type Awaitable<T> = T | Promise<T>;

export type ExtensionAPI = {
  name: string;
  paths: Paths;
  on(
    event: "beforeCleanup",
    handler: (
      event: BeforeCleanupEvent,
      ctx: Context,
    ) => Awaitable<BeforeCleanupResult>,
  ): void;
  on(
    event: "beforeInsert",
    handler: (
      event: BeforeInsertEvent,
      ctx: Context,
    ) => Awaitable<BeforeInsertResult>,
  ): void;
  on(
    event: "recording",
    handler: (event: RecordingEvent, ctx: Context) => Awaitable<void>,
  ): void;
  on(
    event: "afterInsert",
    handler: (event: AfterInsertEvent, ctx: Context) => Awaitable<void>,
  ): void;
  registerCommand(
    phrase: string,
    handler: (event: CommandEvent, ctx: Context) => Awaitable<void>,
    options?: CommandOptions,
  ): void;
  registerSpeechModel(model: SpeechModel): void;
  registerCleanupModel(model: CleanupModel): void;
  registerCleanupStep(step: CleanupStep): void;
  registerAction(action: Action): void;
  settings<Schema extends SettingsSchema>(schema: Schema): SettingsValues<Schema>;
  showActivity(activity: Activity): void;
  hideActivity(): void;
  addTranscript(transcript: Transcript): void;
};

export type Extension = (voz: ExtensionAPI) => Awaitable<void>;

export const apiVersion: 2;

export function defineExtension(extension: Extension): Extension;

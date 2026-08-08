export type StandaloneValidate = ((data: unknown) => boolean) & {
  errors?: readonly unknown[] | null;
};

declare const validators: Readonly<Record<string, StandaloneValidate>>;
export default validators;

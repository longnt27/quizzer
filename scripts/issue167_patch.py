from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing expected text in {path}: {old[:80]!r}")
    target.write_text(text.replace(old, new, 1))


replace(
    "src/types/index.ts",
    "  templates?: PromptTemplates;\n}\n\nexport type PromptTemplateKind",
    "  templates?: PromptTemplates;\n  typeInstructions?: Partial<Record<QuestionType, string>>;\n}\n\nexport type PromptTemplateKind",
)
replace(
    "src/types/index.ts",
    "  templates: PromptTemplates;\n  createdAt: number;",
    "  templates: PromptTemplates;\n  typeInstructions?: Partial<Record<QuestionType, string>>;\n  createdAt: number;",
)

profile_path = Path("src/utils/promptProfiles.ts")
profile_text = profile_path.read_text()
profile_marker = "export const BUILT_IN_PROMPT_PROFILE: PromptProfile = Object.freeze({"
defaults = """export const DEFAULT_TYPE_INSTRUCTIONS: Record<QuestionType, string> = Object.freeze({
  'multiple-choice': 'Create multiple-choice questions with 3-6 credible choices, at least one correct and one incorrect choice, balanced wording, and a useful explanation for every choice.',
  'fill-blank': 'Create fill-in-the-blank questions with exactly one _____ blank, useful accepted answer variants, and one explanation. Prefer meaningful concepts over incidental details.',
  reasoning: 'Create reasoning questions that require explanation, comparison, inference, or application. Provide a clear reference answer and the essential points a good response should contain.',
  coding: 'Create practical coding challenges with an explicit task, expected behavior, constraints, a correct reference solution, and a concise explanation of the approach and edge cases.',
});

"""
if profile_marker not in profile_text:
    raise SystemExit("prompt profile marker missing")
profile_text = profile_text.replace(profile_marker, defaults + profile_marker, 1)
profile_text = profile_text.replace(
    "  templates: Object.freeze({",
    "  typeInstructions: DEFAULT_TYPE_INSTRUCTIONS,\n  templates: Object.freeze({",
    1,
)
profile_text = profile_text.replace(
    "  templates: { ...profile.templates },\n});",
    "  templates: { ...profile.templates },\n  typeInstructions: { ...DEFAULT_TYPE_INSTRUCTIONS, ...profile.typeInstructions },\n});",
    1,
)
profile_path.write_text(profile_text)

replace(
    "src/utils/api.ts",
    "const buildPrompt = (content: string, type: QuestionType, count: number, accepted: QuizQuestion[], focus?: string, multipleChoiceMode?: GenerationOptions['multipleChoiceMode'], template?: string, difficulty?: GenerationDifficulty) => renderGenerationPrompt({",
    "const buildPrompt = (content: string, type: QuestionType, count: number, accepted: QuizQuestion[], focus?: string, multipleChoiceMode?: GenerationOptions['multipleChoiceMode'], template?: string, difficulty?: GenerationDifficulty, profileTypeInstructions?: Partial<Record<QuestionType, string>>) => renderGenerationPrompt({",
)
replace(
    "src/utils/api.ts",
    "  typeInstructions: typeInstructions[type],",
    "  typeInstructions: profileTypeInstructions?.[type] ?? typeInstructions[type],",
)
replace(
    "src/utils/api.ts",
    "          activeOptions.generationProfile?.difficulty), generationQuestionSchemas[type], activeOptions, signal, source.images ?? images);",
    "          activeOptions.generationProfile?.difficulty, activeOptions.promptProfileSnapshot?.typeInstructions), generationQuestionSchemas[type], activeOptions, signal, source.images ?? images);",
)
replace(
    "server/generation-worker.mjs",
    "    count, questionType: type, typeInstructions: typeInstructions[type], multipleChoiceRule,",
    "    count, questionType: type, typeInstructions: options.promptProfileSnapshot?.typeInstructions?.[type] ?? typeInstructions[type], multipleChoiceRule,",
)

studio_path = Path("src/components/PromptStudio.tsx")
studio = studio_path.read_text()
studio = studio.replace(
    "import type { PromptProfile, PromptTemplateKind } from '../types';",
    "import type { PromptProfile, PromptTemplateKind, QuestionType } from '../types';",
    1,
)
studio = studio.replace(
    "  BUILT_IN_PROMPT_PROFILE, promptTemplateErrors, renderGenerationPrompt, renderTemplate, validatePromptProfile,",
    "  BUILT_IN_PROMPT_PROFILE, DEFAULT_TYPE_INSTRUCTIONS, promptTemplateErrors, renderGenerationPrompt, renderTemplate, validatePromptProfile,",
    1,
)
studio = studio.replace(
    "const cloneProfile = (profile: PromptProfile): PromptProfile => ({\n  ...profile,\n  templates: { ...profile.templates },\n});",
    "const cloneProfile = (profile: PromptProfile): PromptProfile => ({\n  ...profile,\n  templates: { ...profile.templates },\n  typeInstructions: { ...DEFAULT_TYPE_INSTRUCTIONS, ...profile.typeInstructions },\n});",
    1,
)
studio = studio.replace(
    "  const [activeTab, setActiveTab] = useState<PromptTemplateKind>('generation');",
    "  const [activeTab, setActiveTab] = useState<PromptTemplateKind | 'type-instructions'>('generation');",
    1,
)
studio = studio.replace(
    "        templates: parsed.templates as PromptProfile['templates'],\n        builtIn: false,",
    "        templates: parsed.templates as PromptProfile['templates'],\n        typeInstructions: { ...DEFAULT_TYPE_INSTRUCTIONS, ...parsed.typeInstructions },\n        builtIn: false,",
    1,
)
studio = studio.replace(
    "  const updateTemplate = (kind: PromptTemplateKind, value: string) => setDraft(current => ({\n    ...current,\n    templates: { ...current.templates, [kind]: value },\n  }));",
    "  const updateTemplate = (kind: PromptTemplateKind, value: string) => setDraft(current => ({\n    ...current,\n    templates: { ...current.templates, [kind]: value },\n  }));\n  const updateTypeInstruction = (kind: QuestionType, value: string) => setDraft(current => ({\n    ...current,\n    typeInstructions: { ...DEFAULT_TYPE_INSTRUCTIONS, ...current.typeInstructions, [kind]: value },\n  }));",
    1,
)
old_tabs = """        <Tabs activeKey={activeTab} onChange={key => setActiveTab(key as PromptTemplateKind)} items={(Object.keys(tabLabels) as PromptTemplateKind[]).map(kind => ({
          key: kind,
          label: tabLabels[kind],
          children: <Space direction=\"vertical\" size=\"small\" style={{ width: '100%' }}>
            <Space size={[4, 4]} wrap>
              <Typography.Text type=\"secondary\">Available placeholders:</Typography.Text>
              {placeholderHelp[kind].map(({ name, description }) => <Popover key={name} title={`{{${name}}}`} content={description} trigger={['hover', 'focus', 'click']}>
                <Tag tabIndex={0} aria-label={`${name} placeholder: ${description}`}>{`{{${name}}}`}</Tag>
              </Popover>)}
            </Space>
            <Input.TextArea className=\"prompt-template-editor\" aria-label={`${tabLabels[kind]} prompt template`} rows={14}
              value={draft.templates[kind]} disabled={Boolean(selected.builtIn)} onChange={event => updateTemplate(kind, event.target.value)} />
            {!!errors[kind]?.length && <Alert type=\"error\" showIcon message={`${tabLabels[kind]} template needs attention`} description={errors[kind]!.join(' ')} />}
          </Space>,
        }))} />"""
new_tabs = """        <Tabs activeKey={activeTab} onChange={key => setActiveTab(key as PromptTemplateKind | 'type-instructions')} items={[
          ...(Object.keys(tabLabels) as PromptTemplateKind[]).map(kind => ({
            key: kind,
            label: tabLabels[kind],
            children: <Space direction=\"vertical\" size=\"small\" style={{ width: '100%' }}>
              <Space size={[4, 4]} wrap>
                <Typography.Text type=\"secondary\">Available placeholders:</Typography.Text>
                {placeholderHelp[kind].map(({ name, description }) => <Popover key={name} title={`{{${name}}}`} content={description} trigger={['hover', 'focus', 'click']}>
                  <Tag tabIndex={0} aria-label={`${name} placeholder: ${description}`}>{`{{${name}}}`}</Tag>
                </Popover>)}
              </Space>
              <Input.TextArea className=\"prompt-template-editor\" aria-label={`${tabLabels[kind]} prompt template`} rows={14}
                value={draft.templates[kind]} disabled={Boolean(selected.builtIn)} onChange={event => updateTemplate(kind, event.target.value)} />
              {!!errors[kind]?.length && <Alert type=\"error\" showIcon message={`${tabLabels[kind]} template needs attention`} description={errors[kind]!.join(' ')} />}
            </Space>,
          })),
          {
            key: 'type-instructions',
            label: 'Type Instructions',
            children: <Space direction=\"vertical\" size=\"middle\" style={{ width: '100%' }}>
              <Typography.Text type=\"secondary\">These values are rendered into the generation template as {'{{typeInstructions}}'} for the matching question type.</Typography.Text>
              {(['multiple-choice', 'fill-blank', 'reasoning', 'coding'] as QuestionType[]).map(kind => <div key={kind}>
                <Typography.Text strong>{kind}</Typography.Text>
                <Input.TextArea aria-label={`${kind} type instruction`} rows={5} maxLength={12000} showCount
                  value={draft.typeInstructions?.[kind] ?? DEFAULT_TYPE_INSTRUCTIONS[kind]} disabled={Boolean(selected.builtIn)}
                  onChange={event => updateTypeInstruction(kind, event.target.value)} />
              </div>)}
            </Space>,
          },
        ]} />"""
if old_tabs not in studio:
    raise SystemExit("PromptStudio tabs block missing")
studio = studio.replace(old_tabs, new_tabs, 1)
studio = studio.replace(
    "        {showPreview && <pre className=\"prompt-preview\">{previewFor(activeTab, draft)}</pre>}",
    "        {showPreview && activeTab !== 'type-instructions' && <pre className=\"prompt-preview\">{previewFor(activeTab, draft)}</pre>}\n        {showPreview && activeTab === 'type-instructions' && <pre className=\"prompt-preview\">{draft.typeInstructions?.['multiple-choice'] ?? DEFAULT_TYPE_INSTRUCTIONS['multiple-choice']}</pre>}",
    1,
)
studio_path.write_text(studio)

Path(".github/workflows/issue-167-patch.yml").unlink(missing_ok=True)
Path("scripts/issue167_patch.py").unlink(missing_ok=True)

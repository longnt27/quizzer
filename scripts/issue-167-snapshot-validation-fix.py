from pathlib import Path


def replace_once(path_name: str, old: str, new: str) -> None:
    path = Path(path_name)
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"expected text not found in {path_name}")
    path.write_text(text.replace(old, new, 1))


replace_once(
    "server/generation-validation.mjs",
    "rejectUnknown(snapshot, new Set(['id', 'version', 'name', 'template', 'templates']), 'Prompt profile snapshot');",
    "rejectUnknown(snapshot, new Set(['id', 'version', 'name', 'template', 'templates', 'typeInstructions']), 'Prompt profile snapshot');",
)

replace_once(
    "server/generation-validation.mjs",
    """    if (templates.generation !== snapshot.template) throw new Error('Prompt profile generation templates do not match');
  }
};""",
    """    if (templates.generation !== snapshot.template) throw new Error('Prompt profile generation templates do not match');
  }
  if (snapshot.typeInstructions !== undefined) {
    const instructions = requireObject(snapshot.typeInstructions, 'Prompt profile type instructions must be an object');
    rejectUnknown(instructions, questionTypes, 'Prompt profile type instructions');
    if (Object.keys(instructions).length !== questionTypes.size) {
      throw new Error('Prompt profile type instructions must contain every question type');
    }
    for (const [type, instruction] of Object.entries(instructions)) {
      if (!boundedText(instruction, 1, 12_000)) throw new Error(`Prompt profile ${type} type instruction must contain 1-12000 characters`);
    }
  }
};""",
)

replace_once(
    "test/generation-validation.test.mjs",
    """    templates: {
      generation,
      grading: 'Grade {{question}} against its reference answer.',
      rag: 'Retrieve direct evidence for this learning query.',
    },
  };
  assert.doesNotThrow(() => validateGenerationOptions({ ...value, promptProfileSnapshot: snapshot }));""",
    """    templates: {
      generation,
      grading: 'Grade {{question}} against its reference answer.',
      rag: 'Retrieve direct evidence for this learning query.',
    },
    typeInstructions: {
      'multiple-choice': 'Use credible distractors and balanced answer choices.',
      'fill-blank': 'Accept concise operational terminology and common equivalents.',
      reasoning: 'Require explanation of the relevant tradeoffs and causal chain.',
      coding: 'Require executable code with explicit cleanup and edge-case handling.',
    },
  };
  assert.doesNotThrow(() => validateGenerationOptions({ ...value, promptProfileSnapshot: snapshot }));
  assert.throws(() => validateGenerationOptions({
    ...value, promptProfileSnapshot: { ...snapshot, typeInstructions: { ...snapshot.typeInstructions, essay: 'Unsupported type.' } },
  }), /unsupported fields: essay/);
  assert.throws(() => validateGenerationOptions({
    ...value, promptProfileSnapshot: { ...snapshot, typeInstructions: { ...snapshot.typeInstructions, reasoning: '' } },
  }), /reasoning type instruction/);
  const incompleteTypeInstructions = { ...snapshot.typeInstructions };
  delete incompleteTypeInstructions.coding;
  assert.throws(() => validateGenerationOptions({
    ...value, promptProfileSnapshot: { ...snapshot, typeInstructions: incompleteTypeInstructions },
  }), /contain every question type/);""",
)

Path(".github/workflows/issue-167-snapshot-validation-fix.yml").unlink()
Path("scripts/issue-167-snapshot-validation-fix.py").unlink()

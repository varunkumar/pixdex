import { describe, expect, it } from 'vitest';
import { hasAnimalCue } from '../src/species/cue';

describe('hasAnimalCue', () => {
  it('is true when the vision model named an animal or an animal category', () => {
    expect(hasAnimalCue(['tiger', 'big cat'], 'Tiger')).toBe(true);
    expect(hasAnimalCue(['wildlife', 'forest'], 'Gaur')).toBe(true);
    expect(hasAnimalCue(['primate', 'monkey'], 'Bonnet macaque')).toBe(true);
    expect(hasAnimalCue(['Indian peafowl (peacock)', 'bird'], 'Peafowl')).toBe(true);
  });

  it('is true when the last word of the predicted name appears in the subjects', () => {
    expect(hasAnimalCue(['flameback', 'tree trunk'], 'Black-rumped Flameback')).toBe(true);
    expect(hasAnimalCue(['Sambar deer'], 'Sambar')).toBe(true);
  });

  it('is false for people, scenery and objects', () => {
    expect(hasAnimalCue(['child', 'girl', 'portrait'], 'Common sunda toad')).toBe(false);
    expect(hasAnimalCue(['river', 'rocks', 'forest', 'sky'], 'Black softshell turtle')).toBe(false);
    expect(hasAnimalCue(['Unknown'], 'Takin')).toBe(false);
    expect(hasAnimalCue([], 'Tiger')).toBe(false);
  });

  it('does not treat a colour or other adjective in the predicted name as a match', () => {
    expect(hasAnimalCue(['black rock', 'river'], 'Black softshell turtle')).toBe(false);
    expect(hasAnimalCue(['common room', 'table'], 'Common sunda toad')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(hasAnimalCue(['catalogue', 'category'], 'Tiger')).toBe(false);
    expect(hasAnimalCue(['hotel', 'batik fabric'], 'Leopard')).toBe(false);
  });
});

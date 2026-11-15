import { describe, expect, it } from 'vitest';
import { decideSpecies, type SpeciesDetection } from '../src/species/decide';

const det = (over: Partial<SpeciesDetection> = {}): SpeciesDetection => ({ model: 'bioclip-2', whole: [], boxes: [], ...over });
const bird = (common: string, scientific: string, score: number, box: [number, number, number, number] = [0.1, 0.1, 0.4, 0.4]) => ({
  box,
  det: 0.6,
  kind: 'bird' as const,
  preds: [[common, scientific, 'Aves', score]] as [string, string, string, number][],
});
const animalBox = (common: string, scientific: string, score: number) => ({
  box: [0, 0, 1, 1] as [number, number, number, number],
  det: 0.5,
  kind: 'animal' as const,
  preds: [[common, scientific, 'Mammalia', score]] as [string, string, string, number][],
});

describe('decideSpecies', () => {
  it('keeps the whole-frame answer when it is confident', () => {
    const out = decideSpecies(det({ whole: [['Tiger', 'Panthera tigris', 'Mammalia', 0.97]] }));
    expect(out).toEqual([{ common: 'Tiger', scientific: 'Panthera tigris', score: 0.97 }]);
  });

  it('drops a whole-frame answer below the threshold', () => {
    expect(decideSpecies(det({ whole: [['Dhole', 'Cuon alpinus', 'Mammalia', 0.47]] }))).toEqual([]);
  });

  it('returns nothing for a photo with no answers', () => {
    expect(decideSpecies(det())).toEqual([]);
  });

  it('adds a confident bird box with its box, and finds both animals in a two-species photo', () => {
    const out = decideSpecies(
      det({
        whole: [['Spotted Deer', 'Axis axis', 'Mammalia', 0.65]],
        boxes: [bird('Jungle myna', 'Acridotheres fuscus', 0.999, [0.4, 0.1, 0.5, 0.2])],
      })
    );
    expect(out).toEqual([
      { common: 'Jungle myna', scientific: 'Acridotheres fuscus', score: 0.999, box: [0.4, 0.1, 0.5, 0.2] },
      { common: 'Spotted Deer', scientific: 'Axis axis', score: 0.65 },
    ]);
  });

  it('ignores a bird box below the threshold', () => {
    const out = decideSpecies(det({ whole: [['Sambar', 'Rusa unicolor', 'Mammalia', 0.9]], boxes: [bird('Great hornbill', 'Buceros bicornis', 0.443)] }));
    expect(out.map((s) => s.common)).toEqual(['Sambar']);
  });

  it('ignores animal boxes: crops of part of a big animal misread it', () => {
    const out = decideSpecies(det({ whole: [['Gaur', 'Bos gaurus', 'Mammalia', 0.9]], boxes: [animalBox('Water buffalo', 'Bubalus bubalis', 0.97)] }));
    expect(out.map((s) => s.common)).toEqual(['Gaur']);
  });

  it('trusts a bird box over the whole-frame answer when the whole frame says a bird', () => {
    const out = decideSpecies(
      det({
        whole: [['Crested Honey Buzzard', 'Pernis ptilorhynchus', 'Aves', 0.94]],
        boxes: [bird('Chanting goshawk', 'Melierax metabates', 0.8)],
      })
    );
    expect(out.map((s) => s.common)).toEqual(['Chanting goshawk']);
  });

  it('keeps a confident whole-frame bird when no bird box is confident', () => {
    const out = decideSpecies(det({ whole: [['Peafowl', 'Pavo cristatus', 'Aves', 0.99]], boxes: [bird('Peafowl', 'Pavo cristatus', 0.3)] }));
    expect(out.map((s) => s.common)).toEqual(['Peafowl']);
  });

  it('lists a species once, keeping its best score and box', () => {
    const out = decideSpecies(
      det({ boxes: [bird('Peafowl', 'Pavo cristatus', 0.8, [0, 0, 0.2, 0.2]), bird('Peafowl', 'Pavo cristatus', 0.95, [0.5, 0.5, 0.7, 0.7])] })
    );
    expect(out).toEqual([{ common: 'Peafowl', scientific: 'Pavo cristatus', score: 0.95, box: [0.5, 0.5, 0.7, 0.7] }]);
  });

  it('lists two different birds, best first, capped at the limit', () => {
    const boxes = Array.from({ length: 8 }, (_, i) => bird(`Bird ${i}`, `Avis ${i}`, 0.6 + i * 0.01));
    const out = decideSpecies(det({ boxes }), { max: 3 });
    expect(out.map((s) => s.common)).toEqual(['Bird 7', 'Bird 6', 'Bird 5']);
  });

  it('rounds scores to three decimals and does not change its input', () => {
    const input = det({ whole: [['Tiger', 'Panthera tigris', 'Mammalia', 0.97349]] });
    const copy = JSON.parse(JSON.stringify(input));
    expect(decideSpecies(input)[0].score).toBe(0.973);
    expect(input).toEqual(copy);
  });

  describe('guarding whole-frame answers with the vision model\'s subjects', () => {
    const toad = det({ whole: [['Common sunda toad', 'Duttaphrynus melanostictus', 'Amphibia', 0.72]] });

    it('drops a mid-confidence whole-frame answer when the subjects show no animal', () => {
      expect(decideSpecies(toad, { subjects: ['woman', 'portrait', 'hotel lobby'] })).toEqual([]);
    });

    it('keeps a mid-confidence whole-frame answer when the subjects name an animal', () => {
      const out = decideSpecies(det({ whole: [['Bonnet macaque', 'Macaca radiata', 'Mammalia', 0.62]] }), { subjects: ['monkey', 'primate'] });
      expect(out.map((s) => s.common)).toEqual(['Bonnet macaque']);
    });

    it('keeps a very confident whole-frame answer even with no sign of an animal', () => {
      const out = decideSpecies(det({ whole: [['Tiger', 'Panthera tigris', 'Mammalia', 0.95]] }), { subjects: ['Unknown'] });
      expect(out.map((s) => s.common)).toEqual(['Tiger']);
    });

    it('keeps a confident bird box whatever the subjects say (the detector saw a bird)', () => {
      const out = decideSpecies(det({ boxes: [bird('Grey-capped Pygmy Woodpecker', 'Yungipicus canicapillus', 0.85)] }), { subjects: ['hotel', 'garden'] });
      expect(out.map((s) => s.common)).toEqual(['Grey-capped Pygmy Woodpecker']);
    });

    it('drops a whole-frame bird with no bird box and no cue, but keeps the species of a confident bird box', () => {
      const out = decideSpecies(
        det({ whole: [['Grey-winged Blackbird', 'Turdus boulboul', 'Aves', 0.7]], boxes: [bird('Rufous Treepie', 'Dendrocitta vagabunda', 0.9)] }),
        { subjects: ['garden'] }
      );
      expect(out.map((s) => s.common)).toEqual(['Rufous Treepie']);
    });

    it('does not guard when no subjects are given (the caller cannot judge)', () => {
      expect(decideSpecies(toad).map((s) => s.common)).toEqual(['Common sunda toad']);
    });
  });
});

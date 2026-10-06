'use strict';
// Segment-based scoring of a vessel read against ground truth.
//
// Each reporting segment (proximal / mid / distal) is graded on:
//   stenosis category   exact 50% · one category off 25% · else 0
//   plaque composition  25%  (None / Calcified / Non-calcified / Mixed)
//   high-risk features  25%  (4 binary features, proportional)
// Vessel score = mean of segment scores. Segments the reader did not touch
// are treated as "no plaque" (CAD-RADS 0), so misses cost points.

const Scoring = (() => {
  const CATS = ['0', '1', '2', '3', '4A', '5'];
  const CAT_LABEL = { '0': '0', '1': '1–24', '2': '25–49', '3': '50–69', '4A': '70–99', '5': '100' };
  const CAT_WORD = { '0': 'none', '1': 'minimal', '2': 'mild', '3': 'moderate', '4A': 'severe', '5': 'occluded' };
  const COMPS = ['None', 'Calcified', 'Non-calcified', 'Mixed'];
  const HRP_KEYS = ['lowAttenuation', 'positiveRemodeling', 'spottyCalcification', 'napkinRing'];
  const HRP_LABEL = { lowAttenuation: 'Low-attenuation plaque', positiveRemodeling: 'Positive remodeling', spottyCalcification: 'Spotty calcification', napkinRing: 'Napkin-ring sign' };
  const HRP_SHORT = { lowAttenuation: 'LAP', positiveRemodeling: 'PR', spottyCalcification: 'Spotty Ca', napkinRing: 'NRS' };
  const ci = c => CATS.indexOf(c);
  const emptyRead = () => ({ cat: '0', comp: 'None', hrp: {} });

  // Truth per segment: worst lesion by stenosis; composition/HRP from it.
  function segmentTruth(vessel) {
    return vessel.segments.map((seg, i) => {
      const ls = vessel.truth.lesions.filter(L => L.segment === i);
      if (!ls.length) return { cat: '0', comp: 'None', hrp: {}, lesion: null, lesions: [] };
      const worst = ls.reduce((a, b) => b.diamStenosis > a.diamStenosis ? b : a);
      const hrp = {}; for (const k of HRP_KEYS) hrp[k] = ls.some(L => L.hrp[k]);
      return { cat: worst.cadRads, comp: worst.composition, hrp, lesion: worst, lesions: ls };
    });
  }

  function scoreVessel(vessel, reads) {
    const truth = segmentTruth(vessel);
    const segs = truth.map((t, i) => {
      const u = reads[i] || emptyRead();
      const d = Math.abs(ci(u.cat) - ci(t.cat));
      const stenPts = d === 0 ? 0.5 : d === 1 ? 0.25 : 0;
      const compPts = u.comp === t.comp ? 0.25 : 0;
      let hrpCorrect = 0; for (const k of HRP_KEYS) if (!!u.hrp[k] === !!t.hrp[k]) hrpCorrect++;
      const hrpPts = 0.25 * hrpCorrect / HRP_KEYS.length;
      return {
        name: vessel.segments[i].name, truth: t, read: u, catDelta: d, stenPts, compPts, hrpPts, hrpCorrect,
        score: Math.round(100 * (stenPts + compPts + hrpPts)),
        hasPlaque: t.cat !== '0', called: u.cat !== '0',
      };
    });
    const total = Math.round(segs.reduce((a, s) => a + s.score, 0) / segs.length);
    const userCat = CATS[Math.max(...segs.map(s => ci(s.read.cat)))];
    const trueCat = vessel.truth.vesselCadRads;
    return {
      total, segs, userCat, trueCat, vesselDelta: Math.abs(ci(userCat) - ci(trueCat)),
      nPlaque: segs.filter(s => s.hasPlaque).length,
      detected: segs.filter(s => s.hasPlaque && s.called).length,
      fp: segs.filter(s => !s.hasPlaque && s.called).length,
      stenExact: segs.filter(s => s.catDelta === 0).length,
      compOK: segs.filter(s => s.compPts > 0).length,
      hrpOK: segs.reduce((a, s) => a + s.hrpCorrect, 0),
      nSegs: segs.length,
    };
  }

  return { scoreVessel, segmentTruth, emptyRead, CATS, CAT_LABEL, CAT_WORD, COMPS, HRP_KEYS, HRP_LABEL, HRP_SHORT };
})();

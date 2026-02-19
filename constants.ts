import { Manufacturer, Project } from './types';

export const STEPS = [
  'Upload',
  'Review',
  'Manufacturer',
  'Specs',
  'Pricing',
  'Details',
  'Download'
];

// Production: Start with empty manufacturer list
export const INITIAL_MANUFACTURERS: Manufacturer[] = [];

export const MOCK_EXTRACTION_RESULTS = [
  { id: '1', originalCode: 'B15', type: 'Base', description: 'Base Cabinet 15" Wide', width: 15, height: 34.5, depth: 24, quantity: 2 },
  { id: '2', originalCode: 'B30', type: 'Base', description: 'Base Cabinet 30" Wide', width: 30, height: 34.5, depth: 24, quantity: 1 },
  { id: '3', originalCode: 'SB36', type: 'Base', description: 'Sink Base 36"', width: 36, height: 34.5, depth: 24, quantity: 1 },
  { id: '4', originalCode: 'W1530', type: 'Wall', description: 'Wall Cabinet 15"x30"', width: 15, height: 30, depth: 12, quantity: 2 },
  { id: '5', originalCode: 'W3030', type: 'Wall', description: 'Wall Cabinet 30"x30"', width: 30, height: 30, depth: 12, quantity: 1 },
  { id: '6', originalCode: 'T2484', type: 'Tall', description: 'Pantry 24"x84"', width: 24, height: 84, depth: 24, quantity: 1 },
  { id: '7', originalCode: 'DB18', type: 'Base', description: 'Drawer Base 18"', width: 18, height: 34.5, depth: 24, quantity: 1 },
  { id: '8', originalCode: 'UNKNOWN_FILLER', type: 'Filler', description: 'Filler strip approx 3"', width: 3, height: 30, depth: 0, quantity: 2 },
];
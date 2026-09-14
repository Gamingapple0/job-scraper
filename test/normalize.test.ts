import { describe, it, expect } from 'vitest';
import {
  parseSalary,
  parseLocation,
  parseDate,
  parseEmploymentType,
  extractTags,
  stripHtml,
} from '../src/core/normalize.js';

describe('parseSalary', () => {
  it('reads an annual range', () => {
    const s = parseSalary('$110,000 – $130,000 + super');
    expect(s?.min).toBe(110000);
    expect(s?.max).toBe(130000);
    expect(s?.period).toBe('year');
  });

  it('reads k-notation', () => {
    const s = parseSalary('120k - 140k');
    expect(s?.min).toBe(120000);
    expect(s?.max).toBe(140000);
  });

  it('reads a day rate', () => {
    const s = parseSalary('$750 - $850 per day');
    expect(s?.min).toBe(750);
    expect(s?.max).toBe(850);
    expect(s?.period).toBe('day');
  });

  it('reads an hourly rate', () => {
    const s = parseSalary('$65 p.h.');
    expect(s?.min).toBe(65);
    expect(s?.period).toBe('hour');
  });

  it('treats "up to" as a ceiling, not a floor', () => {
    const s = parseSalary('Up to $150,000');
    expect(s?.min).toBeUndefined();
    expect(s?.max).toBe(150000);
  });

  it('returns undefined rather than guessing', () => {
    expect(parseSalary(undefined)).toBeUndefined();
    expect(parseSalary('Competitive salary + benefits')).toBeUndefined();
    expect(parseSalary('')).toBeUndefined();
  });

  it('ignores non-salary numbers', () => {
    expect(parseSalary('5 years experience')).toBeUndefined();
  });
});

describe('parseLocation', () => {
  it('collapses Seek metro areas onto one city', () => {
    expect(parseLocation('Melbourne, CBD & Inner Suburbs').city).toBe('Melbourne');
    expect(parseLocation('Melbourne, Eastern Suburbs').city).toBe('Melbourne');
  });

  it('picks up the state', () => {
    expect(parseLocation('Melbourne VIC').state).toBe('VIC');
    expect(parseLocation('Sydney, New South Wales').state).toBe('NSW');
  });

  it('infers the state from a known city when the source omits it', () => {
    expect(parseLocation('Melbourne, CBD & Inner Suburbs').state).toBe('VIC');
    expect(parseLocation('Brisbane').state).toBe('QLD');
  });

  it('flags remote', () => {
    expect(parseLocation('Remote - Australia').remote).toBe(true);
    expect(parseLocation('Melbourne VIC').remote).toBe(false);
    expect(parseLocation('Melbourne VIC', true).remote).toBe(true);
  });

  it('detects non-AU countries from LinkedIn-style location text', () => {
    expect(parseLocation('Dublin, County Dublin, Ireland').country).toBe('IE');
    expect(parseLocation('Berlin, Berlin, Germany').country).toBe('DE');
    expect(parseLocation('London, England, United Kingdom').country).toBe('GB');
    expect(parseLocation('Auckland, Auckland, New Zealand').country).toBe('NZ');
    expect(parseLocation('Toronto, Ontario, Canada').country).toBe('CA');
    expect(parseLocation('Singapore').country).toBe('SG');
    expect(parseLocation('Dubai, United Arab Emirates').country).toBe('AE');
    expect(parseLocation('Amsterdam, North Holland, Netherlands').country).toBe('NL');
  });

  it('still defaults to AU for Seek-style strings with no country name', () => {
    expect(parseLocation('Melbourne, CBD & Inner Suburbs').country).toBe('AU');
    expect(parseLocation('Sydney, New South Wales').country).toBe('AU');
  });
});

describe('parseDate', () => {
  const now = new Date('2026-09-05T00:00:00Z');

  it('passes ISO through', () => {
    expect(parseDate('2026-09-03T22:14:00Z', now)).toBe('2026-09-03T22:14:00.000Z');
  });

  it('resolves relative strings at scrape time', () => {
    expect(parseDate('3 days ago', now)).toBe('2026-09-02T00:00:00.000Z');
    expect(parseDate('30+ days ago', now)).toBe('2026-08-06T00:00:00.000Z');
    expect(parseDate('2 hours ago', now)).toBe('2026-09-04T22:00:00.000Z');
  });

  it('handles today and yesterday', () => {
    expect(parseDate('Just posted', now)).toBe(now.toISOString());
    expect(parseDate('yesterday', now)).toBe('2026-09-04T00:00:00.000Z');
  });

  it('gives up cleanly', () => {
    expect(parseDate('sometime soon', now)).toBeUndefined();
    expect(parseDate(undefined, now)).toBeUndefined();
  });
});

describe('parseEmploymentType', () => {
  it('maps source labels', () => {
    expect(parseEmploymentType('Full time')).toBe('full-time');
    expect(parseEmploymentType('Contract/Temp')).toBe('contract');
    expect(parseEmploymentType('Part time')).toBe('part-time');
    expect(parseEmploymentType('Casual/Vacation')).toBe('casual');
    expect(parseEmploymentType(undefined, 'Software Engineering Internship')).toBe('internship');
    expect(parseEmploymentType(undefined, 'Software Engineer')).toBe('unknown');
    // A graduate role is a permanent job, not an internship: it stays unknown
    // here and is picked up by the "junior" tag instead.
    expect(parseEmploymentType(undefined, 'Graduate Software Engineer')).toBe('unknown');
  });
});

describe('extractTags', () => {
  it('finds stack keywords without false positives on javascript/java', () => {
    const tags = extractTags('Software Engineer', 'Java, Spring Boot and PostgreSQL on AWS');
    expect(tags).toContain('java');
    expect(tags).toContain('spring');
    expect(tags).toContain('postgres');
    expect(tags).toContain('aws');
    expect(tags).not.toContain('javascript');
  });

  it('reads seniority from the title only', () => {
    const junior = extractTags('Junior Frontend Developer', 'mentored by senior engineers');
    expect(junior).toContain('junior');
    expect(junior).not.toContain('senior');

    expect(extractTags('Senior Software Engineer', 'work with junior devs')).toContain('senior');
  });

  it('picks up "automated testing" phrasing, not just "automation test"', () => {
    expect(extractTags('', 'Knowledge of automated testing and contemporary development practices')).toContain(
      'testing',
    );
  });

  it('extracts the full skill set from a real job ad', () => {
    // Trimmed from a real Seek listing pasted by the user.
    const body = `
      Building backend services using Java and Spring Boot
      Developing and integrating REST APIs
      Working across AWS-based applications and services
      Designing and delivering microservice-based solutions
      Knowledge of automated testing and contemporary development practices
      Experience working within Agile engineering teams
      Java | Spring Boot | AWS | Microservices | REST APIs`;
    const tags = extractTags('Java Software Engineers | Mid-Level & Senior', body);
    expect(tags).toEqual(
      expect.arrayContaining(['java', 'spring', 'aws', 'rest', 'microservices', 'testing', 'agile', 'senior']),
    );
  });

  it('flags visa and clearance conditions', () => {
    expect(extractTags('', 'Must be an Australian citizen')).toContain('citizen-only');
    expect(extractTags('', 'Visa sponsorship is available')).toContain('visa-sponsorship');
  });
});

describe('stripHtml', () => {
  it('turns markup into readable text', () => {
    const out = stripHtml('<p>Build things.</p><ul><li>Java</li><li>React</li></ul>');
    expect(out).toContain('Build things.');
    expect(out).toContain('- Java');
    expect(out).not.toContain('<');
  });
});

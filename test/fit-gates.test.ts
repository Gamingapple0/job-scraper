import { describe, it, expect } from 'vitest';
import { hardGate } from '../src/core/fit-gates.js';

const job = (title: string, company = 'Xero', description = 'Build Java services with Spring Boot.', tags: string[] = []) => ({ title, company, description, tags });

describe('hardGate', () => {
  it('passes a junior/graduate role at a direct employer', () => {
    expect(hardGate(job('Graduate Software Engineer'))).toBeNull();
    expect(hardGate(job('Software Engineer, Database Reliability'))).toBeNull();
    expect(hardGate(job('Associate Software Engineer', 'Macquarie Group'))).toBeNull();
    expect(hardGate(job('SDET', 'Canva'))).toBeNull();
  });

  it('gates citizenship, PR and clearance, from the body or the scrape tag', () => {
    expect(hardGate(job('Graduate Developer', 'DTP', 'Applicants must be an Australian citizen.'))).toMatch(/citizenship/);
    expect(hardGate(job('Software Engineer', 'Gov', 'Must hold or be able to obtain a Baseline clearance.'))).toMatch(/clearance/);
    expect(hardGate(job('Software Engineer', 'GovTech', 'Singapore citizens only.'))).toMatch(/citizenship/);
    expect(hardGate(job('Software Engineer', 'X', 'ok', ['citizen-only']))).toMatch(/citizen-only/);
  });

  it('gates body shops, aggregators and the blacklist without catching look-alikes', () => {
    expect(hardGate(job('Java Developer', 'Infosys Limited'))).toMatch(/drop list/);
    expect(hardGate(job('Software Engineer', 'Jobgether'))).toMatch(/drop list/);
    expect(hardGate(job('Software Engineer', 'TCS'))).toMatch(/drop list/);
    expect(hardGate(job('Software Engineer', 'Atcs Pty Ltd'))).toBeNull();
  });

  it('gates seniority and dropped role families from the title', () => {
    expect(hardGate(job('Senior Java Developer'))).toMatch(/above the junior band/);
    expect(hardGate(job('Software Engineer III'))).toMatch(/above the junior band/);
    expect(hardGate(job('Associate, Technology - VP'))).toMatch(/above the junior band/);
    expect(hardGate(job('DevOps Engineer'))).toMatch(/dropped/);
    expect(hardGate(job('Site Reliability Engineer'))).toMatch(/dropped/);
    expect(hardGate(job('Associate Security Engineer'))).toMatch(/dropped/);
    expect(hardGate(job('Manual Tester'))).toMatch(/dropped/);
  });

  it('gates non-English postings', () => {
    expect(hardGate(job('Java-ontwikkelaar'))).toMatch(/non-English/);
    const de = 'Wir suchen für unser Team einen Entwickler mit Erfahrung und der Bereitschaft, die Plattform mit uns und das Team zu bauen. '.repeat(4);
    expect(hardGate(job('Full Stack Developer', 'Acme GmbH', de))).toMatch(/non-English/);
  });
});

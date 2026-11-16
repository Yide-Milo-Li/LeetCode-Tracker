/** Parsed summaries retain each suite boundary instead of assuming a fixed total. */
export interface TestSummary {tests:number;passed:number;failed:number}
export interface AcceptanceCheckResult {
  passed:boolean;
  candidate:string;
  errors:string[];
  engineering:Array<{name:string;summaries:TestSummary[]}>;
}
export function testSummaries(log:string):TestSummary[];
export function checkAcceptance(matrixPath:string,candidatePath:string):Promise<AcceptanceCheckResult>;

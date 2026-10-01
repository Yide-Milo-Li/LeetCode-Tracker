/** Experimental allowlist. Reads expose public preferences and never start generation. */
import {z} from 'zod';
import type {TrackerApplication} from '../../packages/application/src/application.ts';
import {ApplicationError} from '../../packages/application/src/errors.ts';
const id=z.string().trim().min(1).max(200);
export function createExperimentTools(application:TrackerApplication,onWrite:()=>void=()=>{}) {
  const tools={
    tracker_preferences:{schema:z.object({}),write:false,run:async()=>{const settings=await application.settings.get();return {timezone:settings.timezone,language:settings.language,theme:settings.theme,palette:settings.palette};}},
    tracker_strategies:{schema:z.object({}),write:false,run:()=>application.planning.strategies()},
    tracker_today:{schema:z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}),write:false,run:async(args:Record<string,unknown>)=>{const settings=await application.settings.get();const date=args.date??new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone??'UTC'}).format(new Date());return application.planning.plans({date});}},
    tracker_notes:{schema:z.object({scope:z.enum(['all','practiced']).optional(),search:z.string().max(200).optional(),difficulty:z.enum(['all','Easy','Medium','Hard']).optional(),hasNote:z.enum(['all','true','false']).optional(),page:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}),write:false,run:(args:Record<string,unknown>)=>application.notes.list(args)},
    tracker_note:{schema:z.object({frontendId:id}),write:false,run:(args:Record<string,unknown>)=>application.notes.read({}, {frontendId:String(args.frontendId)})},
    tracker_practices:{schema:z.object({questionFrontendId:id,page:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}),write:false,run:(args:Record<string,unknown>)=>application.practice.query(args)},
    tracker_append:{schema:z.object({planId:id,expectedVersion:z.number().int().positive(),operationId:z.string().uuid().optional()}),write:true,run:(args:Record<string,unknown>)=>application.planning.append({expectedVersion:args.expectedVersion,operationId:args.operationId},{id:String(args.planId)})},
    tracker_save_note:{schema:z.object({frontendId:id,content:z.string().max(100000)}),write:true,run:(args:Record<string,unknown>)=>application.notes.save({content:args.content},{frontendId:String(args.frontendId)})},
  };
  async function call(name:string,args:unknown) {
    try {
      const tool=tools[name as keyof typeof tools];
      if(!tool)throw new ApplicationError(403,{error:'TOOL_NOT_ALLOWED',message:'Tool is outside the experimental allowlist'});
      const parsed=tool.schema.safeParse(args);
      if(!parsed.success)throw new ApplicationError(400,{error:'INVALID_INPUT',message:parsed.error.message});
      const data=await tool.run(parsed.data);
      if(tool.write)onWrite();
      return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:{data}};
    } catch(error) {
      const details=error instanceof ApplicationError?{status:error.status,...error.details}:{status:500,error:'INTERNAL_ERROR',message:error instanceof Error?error.message:String(error)};
      return {isError:true,content:[{type:'text' as const,text:JSON.stringify(details)}],structuredContent:details};
    }
  }
  return {tools,call};
}

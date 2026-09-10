import {Pool} from 'pg';
import '@/lib/pgTypes';
import {log} from '@/lib/logger';
let pool:Pool|undefined;
/** Separate capacity: callers already hold a request's auth connection. */
export function getAccessReviewPool():Pool{
 if(pool)return pool;
 const connectionString=process.env.DATABASE_URL;if(!connectionString)throw new Error('DATABASE_URL required');
 pool=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,statement_timeout:10000,
  ssl:process.env.DATABASE_SSL==='disable'?false:{rejectUnauthorized:process.env.DATABASE_SSL==='strict'}});
 pool.on('error',()=>log.warn('Access review pool background failure',{},'Auth'));
 return pool;
}
export async function closeAccessReviewPool(){const current=pool;pool=undefined;if(current)await current.end();}

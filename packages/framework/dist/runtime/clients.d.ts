import { GRPC as Cerbos } from '@cerbos/grpc';
import * as Minio from 'minio';
import { Pool } from 'pg';
export declare const getCerbosClient: () => Cerbos;
export declare const getMinioClient: () => Minio.Client;
export declare const getDbPool: () => Pool;

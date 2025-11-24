"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDbPool = exports.getMinioClient = exports.getCerbosClient = void 0;
const grpc_1 = require("@cerbos/grpc");
const Minio = __importStar(require("minio"));
const pg_1 = require("pg");
// Singleton instances
let cerbosClient = null;
let minioClient = null;
let pgPool = null;
const getCerbosClient = () => {
    if (!cerbosClient) {
        const target = process.env.CERBOS_URL || 'cerbos.default.svc.cluster.local:3593';
        cerbosClient = new grpc_1.GRPC(target, { tls: false });
        console.log(`Connected to Cerbos at ${target}`);
    }
    return cerbosClient;
};
exports.getCerbosClient = getCerbosClient;
const getMinioClient = () => {
    if (!minioClient) {
        minioClient = new Minio.Client({
            endPoint: process.env.MINIO_ENDPOINT || 'minio.default.svc.cluster.local',
            port: parseInt(process.env.MINIO_PORT || '9000'),
            useSSL: process.env.MINIO_USE_SSL === 'true',
            accessKey: process.env.MINIO_ACCESS_KEY || 'minio',
            secretKey: process.env.MINIO_SECRET_KEY || 'minio123',
        });
        console.log('Connected to MinIO');
    }
    return minioClient;
};
exports.getMinioClient = getMinioClient;
const getDbPool = () => {
    if (!pgPool) {
        pgPool = new pg_1.Pool({
            connectionString: process.env.DATABASE_URL,
        });
        console.log('Connected to Postgres');
    }
    return pgPool;
};
exports.getDbPool = getDbPool;

import { IInternalRouteInjector } from "../../../app/interfaces/IRouteInjector";
import Logger = require("../../../app/internals/Logger");
import FSUtils = require("../../../utils/FSUtils");
import NotFound = require("../../../responses/NotFound");
import multer = require("multer");
import { Request } from "express";
import * as child from 'child_process';
import { format } from 'util';
import * as path from "path";
import * as fs from "fs";
import { promisify } from "util";
import * as sharp from "sharp";

import ArgumentUtils = require("../../../utils/ArgumentUtils");
class GalleryInjector {
    static logger = Logger.getLogger();

    private routeInjector: IInternalRouteInjector;
    private galleryConfig: IGalleryConfig;

    private galleryFilepath: string;
    private galleryEndpoint: string;
    private prefix: string;

    private listDirectoryRoles: string[];
    private postImageRoles: string[];
    private deleteImageRoles: string[];

    private checkRole;
    private getUserIfExists;

    private upload;

    constructor(routeInjector: IInternalRouteInjector) {
        this.routeInjector = routeInjector;
        this.galleryConfig = this.routeInjector.config.env.images && this.routeInjector.config.env.images.gallery || undefined;
        this.prefix = this.routeInjector.config.routes.prefix;
    }

    public static create(routeInjector: IInternalRouteInjector): GalleryInjector {
        return new GalleryInjector(routeInjector);
    }

    public inject() {
        if (!this.galleryConfig) {
            GalleryInjector.logger.debug("GalleryConfig is not found. Not Injecting.");
            return;
        }
        GalleryInjector.logger.debug("GalleryConfig found. Injecting.");
        this.loadConfiguration();
        this.loadSecurityModule();
        this.createGalleryFilepathIfRequired();
        this.setupMulterMiddleware();
        this.handleGetImage();
        this.handleGetImagesList();
        this.handlePostImage();
        this.handleDeleteImage();
    }

    private createGalleryFilepathIfRequired() {
        if (FSUtils.exists(this.galleryFilepath))
            return;
        GalleryInjector.logger.debug("[ GalleryInjector ] -> Creating filepath", this.galleryFilepath);
        FSUtils.createDirectory(this.galleryFilepath)
    }

    private loadConfiguration() {
        this.galleryEndpoint = this.galleryConfig.endpoint;
        this.galleryFilepath = this.galleryConfig.filepath;
        this.listDirectoryRoles = this.galleryConfig.listDirectory;
        this.postImageRoles = this.galleryConfig.postImage;
        this.deleteImageRoles = this.galleryConfig.deleteImage;
    }

    private loadSecurityModule() {
        this.checkRole = this.routeInjector.security.checkRole;
        this.getUserIfExists = this.routeInjector.security.getUserIfExists;
    }

    private handleGetImagesList() {
        this.routeInjector.app.get(this.prefix + this.galleryEndpoint + "/:path(*)", this.getUserIfExists.middleware, this.checkRole(this.listDirectoryRoles).middleware, this.fileExistsMiddleware, (req, res, next) => {
            let path = req.filepath;
            let files = FSUtils.getClassifiedFileMap(path);
            res.json(files);
            res.end();
        });
    }

    private handlePostImage() {
        this.routeInjector.app.post(this.prefix + this.galleryEndpoint + "/:path(*)", this.getUserIfExists.middleware,
            this.checkRole(this.postImageRoles).middleware, this.upload.array("file[]"), (req, res, next) => {
                let files = req.files;
                let path = req.param("path", "");
                if (path !== "") {
                    FSUtils.createDirectory(FSUtils.join(this.galleryFilepath, path));
                }

                let partialPath = this.prefix + this.galleryEndpoint + "/" + path;
                if (path) {
                    partialPath = partialPath + "/"
                }
                for (let i = 0; i < files.length; i++) {
                    files[i] = partialPath + files[i].originalname;
                }
                res.statusCode = 201;
                res.json(files);
                return res.end();
            });
    }

    private optimiseImage(image, callback) {
        GalleryInjector.logger.debug("OPTIMIZING ", image);
        if (/\.png$/i.test(image)) {
            GalleryInjector.logger.debug("PNG", image);
            image = image.replace("$", "\\$");
            let p = child.exec(format('optipng "%s"', image), callback);

            p.stdout.on('data', function (data) {
                GalleryInjector.logger.debug(data);
            });

            p.stderr.on('data', function (data) {
                GalleryInjector.logger.debug(data);
            });

        } else if (/\.jpe?g$/i.test(image)) {
            image = image.replace("$", "\\$");
            GalleryInjector.logger.debug("JPEG ", image);
            let p = child.exec(format('jpegoptim -m90 -o "%s"', image), callback);

            p.stdout.on('data', function (data) {
                GalleryInjector.logger.debug(data);
            });

            p.stderr.on('data', function (data) {
                GalleryInjector.logger.debug(data);
            });
        } else {
            callback();
        }
    }

    private handleGetImage() {
        let IMGR = require('imgr').IMGR;
        let config = this.routeInjector.config.env.images.imgrConfig || {};
        if (config.optimisation == undefined) {
            config.optimisation = this.optimiseImage;
        }
        let imgr = new IMGR(config);

        function supportsWebP(headers) {

            if (headers.accept && headers.accept.includes("image/webp")) {
                /* Por aquí entran chrome y opera */
                return true;

            } else {


                if (headers["user-agent"]) {

                    if (headers["user-agent"].includes("Firefox")) {
                        /* Firefox por encima de la 65 ok: */
                        let version = parseFloat(headers["user-agent"].split("/").pop());
                        return version >= 65; /* https://caniuse.com/#search=webp */

                    }
                }
            }

            return false;
        }

        this.routeInjector.app.use(async (req, res, next) => {

            function end (err) {

                if(!err)
                    req.url = req.url.split(".").slice(0, -1).join(".") + ".webp";

                next();
            }

            try {

                if (req.url.startsWith(this.prefix + this.galleryEndpoint)) {


                    let fileName = req.url.split("/").pop();
                    let fileAbs = path.join(this.routeInjector.config.env.images.path, fileName);

                    if (await promisify(fs.exists)(fileAbs)) {

                        if (supportsWebP(req.headers)) {

                            let size = req.url.split("/").slice(-2)[0];
                            let [widthStr, heightStr] = size.split("x");

                            let width = !isNaN(parseInt(widthStr)) ? parseInt(widthStr) : null;
                            let height = !isNaN(parseInt(heightStr)) ? parseInt(heightStr) : null;
                            let fileNameNoExt = fileName.split(".").slice(0, -1).join(".");

                            let outputFile = path.join(this.routeInjector.config.env.images.cache, width ? size : "", fileNameNoExt + ".webp");

                            if (! await promisify(fs.exists)(outputFile)) {
                            
                                if (width) {

                                    if (height) {

                                        sharp(fileAbs).resize(width, height).toFile(outputFile, end);
                            
                                    } else {

                                        sharp(fileAbs).resize(width).toFile(outputFile, end);

                                    }
                            
                                } else {

                                    sharp(fileAbs).toFile(outputFile, end);

                                }

                            } else {

                                req.url = req.url.split(".").slice(0, -1).join(".") + ".webp";
                                next();
                                
                            }
                        } else
                            next()
                    } else
                        next();
                } else 
                    next();

            } catch (err) {

                next();
            }
        })

        imgr.serve(this.routeInjector.config.env.images.path) //folder
            .namespace(this.prefix + this.galleryEndpoint)// /image
            .cacheDir(this.routeInjector.config.env.images.cache)
            .urlRewrite('/:path/:size/:file.:ext') // '/:path/:size/:file.:ext'
            .using(this.routeInjector.app);
    }

    private handleDeleteImage() {
        this.routeInjector.app.delete(this.prefix + this.galleryEndpoint + "/:path(*)", this.getUserIfExists.middleware, this.checkRole(this.deleteImageRoles).middleware, this.fileExistsMiddleware, (req, res, next) => {
            FSUtils.remove(req.filepath);
            res.statusCode = 200;
            res.json({
                message: req.filepath + " has been removed"
            });
            return res.end();
        });
    }

    private fileExistsMiddleware = (req, res, next) => {
        let reqPath = req.params.path;
        let path = FSUtils.join(this.galleryFilepath, reqPath);
        if (!FSUtils.exists(path)) {
            return next(new NotFound(reqPath + " not found"));
        }
        req.filepath = path;
        return next();
    };

    private setupMulterMiddleware() {
        let storage = multer.diskStorage({
            destination: (req, file, cb) => {
                let reqPathParam = (req as Request).param("path", ".");
                let path = FSUtils.join(this.galleryFilepath, reqPathParam);
                if (!FSUtils.exists(path))
                    FSUtils.createDirectory(path);
                cb(null, path);
            },
            filename: (req, file, cb) => {
                cb(null, file.originalname);
            }
        });
        this.upload = multer({
            storage: storage
        });
    }
}

export = GalleryInjector;

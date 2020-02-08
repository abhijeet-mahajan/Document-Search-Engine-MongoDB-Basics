const assert = require('assert');
const mongo = require('mongodb').MongoClient;

const {inspect} = require('util'); //for debugging

'use strict';

/** This class is expected to persist its state.  Hence when the
 *  class is created with a specific database url, it is expected
 *  to retain the state it had when it was last used with that URL.
 */ 

class DocFinder {

  /** Constructor for instance of DocFinder. The dbUrl is
   *  expected to be of the form mongodb://SERVER:PORT/DB
   *  where SERVER/PORT specifies the server and port on
   *  which the mongo database server is running and DB is
   *  name of the database within that database server which
   *  hosts the persistent content provided by this class.
   */
  constructor(dbUrl) {
    this.dbUrl=dbUrl;
    this.database=null;
    this.noiseWords=new Set();
  }

  /** This routine is used for all asynchronous initialization
   *  for instance of DocFinder.  It must be called by a client
   *  immediately after creating a new instance of this.
   */
  async init() {
    this.database = await mongo.connect(this.dbUrl, { useNewUrlParser: true });
    this.dbo = this.database.db("docs");

  }

  /** Release all resources held by this doc-finder.  Specifically,
   *  close any database connections.
   */
  async close() {
    try{
      if(this.dbo.serverConfig.isConnected()){
        await this.database.close();
      }
    }catch(x){
    }
  }

  /** Clear database */
  async clear() {
    let that=this;
    return new Promise( function( resolve, reject ) {

       that.dbo.collection("data").deleteMany(function(err, obj) {
        if (err) throw err;
      });

       that.dbo.collection("noise").deleteMany(function(err, obj) {
        if (err) throw err;
      });
      resolve();
    });
  }

  /** Return an array of non-noise normalized words from string
   *  contentText.  Non-noise means it is not a word in the noiseWords
   *  which have been added to this object.  Normalized means that
   *  words are lower-cased, have been stemmed and all non-alphabetic
   *  characters matching regex [^a-z] have been removed.
   */
  async words(contentText) {
    return contentText.replace(/\s\s+/g, ' ').split(' ').map( term => normalize(term) );
  }

  /** Add all normalized words in the noiseText string to this as
   *  noise words.  This operation should be idempotent.
   */
  async fetchNoiseWordsList(){
    let that=this;
    return new Promise( function( resolve, reject ) {
      that.dbo.collection('noise').find().toArray(function(err, docs) {
        if(docs){
          docs.forEach(function(doc){
            that.noiseWords.add(doc.word);
          });
        }
        if(err){};
        resolve();
      });
    });




  }

  async addNoiseWords(noiseText) {
//    await this.fetchNoiseWordsList();
    let that=this;
    let words= new Set(noiseText.split(/[\r\n]+/g));

    words.forEach(function(w){
      if(!that.noiseWords.has(x=>x.word==w))
      {that.noiseWords.add(new NoiseWord(w))}
    });

    await this.dbo.collection("noise").insertMany(Array.from(that.noiseWords), function(err, res) {
      if (err) throw err;
      if(res){
      }
    });
  }

  /** Add document named by string name with specified content string
   *  contentText to this instance. Update index in this with all
   *  non-noise normalized words in contentText string.
   *  This operation should be idempotent.
   */ 
  async addContent(name, contentText) {
    await this.fetchNoiseWordsList();
    let that=this;

    let file=new FileDissection(name,contentText);
    contentText.split(/[\r\n]+/g).map((line,index) => {
      line.replace(/\s\s+/g, ' ').split(' ').map(word => {
        word=normalize(word);
        if(!that.noiseWords.has(word))
          file.ProcessWord(word,line,index);
      })
    })

    await this.dbo.collection("data").updateOne({"fileName":name},{ $set:file},{ upsert: true }, function(err, res) {
      if (err) throw err;
      if(res) {};
    });
  }

  /** Return contents of document name.  If not found, throw an Error
   *  object with property code set to 'NOT_FOUND' and property
   *  message set to `doc ${name} not found`.
   */
  async docContent(name) {
    let that=this;

    return new Promise( function( resolve, reject ) {
      let query={fileName:name};
      let fields={ projection: {fileText:1, _id:0}};

       that.dbo.collection('data').find(query,fields).toArray(function(err, docs) {
        if(docs && docs.length>0){
          resolve( docs[0].fileText);
        }
        else{
          //  let error= new Error(`doc ${name} not found`);
          //  error.code="NOT_FOUND";
           resolve(`doc ${name} not found\n`);
        }
      });
    });
  }

  
  async find(terms) {
    let that=this;
    let resultList=new Set();

    return new Promise( function( resolve, reject ) {
      let query={"fileData.word":{$in :terms}};
      that.dbo.collection('data').find(query).toArray(function(err, docs) {
        if(docs){
          docs.forEach(function(doc){
            let count=0;
            let lines=doc.fileText.split(/[\r\n]+/g);
            let firstLineindex=lines.length-1;
            for(let i=0;i<terms.length;i++){
              let data=doc.fileData.find(x=> x.word==terms[i]);
              if(data){              
                count = count + data.wordCount;
                if(firstLineindex > data.firstOccurenceLineNumber){firstLineindex=data.firstOccurenceLineNumber;}
              }
            }
            resultList.add(new Result(doc.fileName,count,lines[firstLineindex]));
          });
        }
        if(err){};
        resolve(Array.from(resultList).sort(compareResults));
      });
    });
  }

  /** Given a text string, return a ordered list of all completions of
   *  the last normalized word in text.  Returns [] if the last char
   *  in text is not alphabetic.
   */
  async complete(text) {
    text=text.replace(/\s\s+/g, ' ').split(' ').pop();
    let that=this;
    let resultList=new Set();

    return new Promise( function( resolve, reject ) {
      that.dbo.collection('data').find({}).toArray(function(err, docs) {
        if(docs){
          docs.forEach(function(doc){
            let reducedList=doc.fileData.filter(obj=>obj.word.startsWith(text));
            reducedList.forEach(function(wordObject){
              resultList.add(wordObject.word);
            });
          });
        }
        if(err){};
        resolve(Array.from(resultList));
      });
    });
  }
} //class DocFinder

module.exports = DocFinder;

//Add module global functions, constants classes as necessary
//(inaccessible to the rest of the program).

//Used to prevent warning messages from mongodb.
const MONGO_OPTIONS = {
  useNewUrlParser: true
};

/** Regex used for extracting words as maximal non-space sequences. */
const WORD_REGEX = /\S+/g;

/** A simple utility class which packages together the result for a
 *  document search as documented above in DocFinder.find().
 */ 

class NoiseWord{
  constructor(word){
    this.word=word;
  }
}

class FileDissection{
  constructor(name,text){
    this.fileName=name;
    this.fileText=text;
    this.fileData=new Array();   //array of word information
  }

  ProcessWord(word,line,index){
    this.fileData.some(function(file){
       if(file.word == word) {
          file.wordCount++;
          return file
        };
    })
    let wordInformation=new WordInformation(word,line,index);
    this.fileData.push(wordInformation);
    
    return wordInformation;
  }
}

class WordInformation{
  constructor(word,line,index){
    this.word=word;
    this.wordCount=1;
    this.firstOccurenceLineNumber=index;
  }
}

class Result {
  constructor(name, score, lines) {
    this.name = name; this.score = score; this.lines = lines;
  }

  toString() { return `${this.name}: ${this.score}\n${this.lines}`; }
}

/** Compare result1 with result2: higher scores compare lower; if
 *  scores are equal, then lexicographically earlier names compare
 *  lower.
 */
function compareResults(result1, result2) {
  return (result2.score - result1.score) ||
    result1.name.localeCompare(result2.name);
}

/** Normalize word by stem'ing it, removing all non-alphabetic
 *  characters and converting to lowercase.
 */
function normalize(word) {
  return stem(word.toLowerCase()).replace(/[^a-z]/g, '');
}

/** Place-holder for stemming a word before normalization; this
 *  implementation merely removes 's suffixes.
 */
function stem(word) {
  return word.replace(/\'s$/, '');
}




import academicSearchAction from './search/academicSearch';
import legalSearchAction from './search/legalSearch';
import verifyLegalCitationAction from './verifyLegalCitation';
import doneAction from './done';
import planAction from './plan';
import ActionRegistry from './registry';
import scrapeURLAction from './scrapeURL';
import socialSearchAction from './search/socialSearch';
import uploadsSearchAction from './uploadsSearch';
import webSearchAction from './search/webSearch';

ActionRegistry.register(webSearchAction);
ActionRegistry.register(doneAction);
ActionRegistry.register(planAction);
ActionRegistry.register(scrapeURLAction);
ActionRegistry.register(uploadsSearchAction);
ActionRegistry.register(academicSearchAction);
ActionRegistry.register(socialSearchAction);
ActionRegistry.register(legalSearchAction);
ActionRegistry.register(verifyLegalCitationAction);

export { ActionRegistry };
